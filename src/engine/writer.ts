// Format-preserving frontmatter edits.
//
// Obsidian's processFrontMatter re-serializes the whole block and changes
// MIF values on the way. This writer splices text
// instead: only the bytes of the edited key change, new keys go in at their
// canonical position (FRONTMATTER_ORDER), and every result is re-parsed and
// compared with the intended frontmatter before it is returned. An edit that
// would disturb any other value throws instead of writing.

import { isMap, isNode, isScalar, isSeq, parseDocument, type Pair } from "yaml";

import { FRONTMATTER_ORDER, FrontmatterError, parseMarkdown, type Frontmatter } from "./convert";
import { dumpYaml, LOAD_OPTIONS } from "./yaml11";

export class WriteError extends Error {
  override name = "WriteError";
}

interface Split {
  /** Text before the YAML (always "---\n"). */
  head: string;
  yaml: string;
  /** Closing delimiter and everything after it. */
  tail: string;
}

function split(text: string): Split | null {
  // Same boundaries as mif_convert.FRONTMATTER_RE: "---\n" at offset 0, then
  // the first "\n---" at or after offset 4 closes the block.
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---", 4);
  if (close === -1) return null;
  return { head: "---\n", yaml: text.slice(4, close), tail: text.slice(close) };
}

interface PairSpan {
  key: string;
  /** Offset of the key's first character. */
  start: number;
  /** Offset just past the line holding the end of the value (incl. "\n"). */
  end: number;
  /** Value offsets when the whole pair sits on one line as a plain/quoted scalar. */
  inlineValue?: [number, number];
}

function pairSpans(yaml: string): PairSpan[] {
  const doc = parseDocument(yaml, LOAD_OPTIONS);
  if (doc.errors.length) throw new FrontmatterError(`Invalid YAML frontmatter: ${doc.errors[0]!.message}`);
  if (doc.contents === null) return [];
  if (!isMap(doc.contents)) throw new FrontmatterError("Frontmatter is not a mapping");
  const lineEnd = (offset: number) => {
    const nl = yaml.indexOf("\n", offset);
    return nl === -1 ? yaml.length : nl + 1;
  };
  return (doc.contents.items as Pair[]).map((pair) => {
    const keyNode = pair.key;
    if (!isScalar(keyNode) || !keyNode.range) throw new WriteError("Unsupported frontmatter key");
    const start = keyNode.range[0];
    const value = pair.value;
    const valueRange = isNode(value) ? value.range : undefined;
    const valueEnd = valueRange ? valueRange[1] : keyNode.range[1];
    const end = lineEnd(Math.max(valueEnd - 1, keyNode.range[1]));
    const span: PairSpan = { key: String(keyNode.value), start, end };
    if (isScalar(value) && value.range && value.type !== "BLOCK_LITERAL" && value.type !== "BLOCK_FOLDED") {
      const [vs, ve] = value.range;
      if (!yaml.slice(start, ve).includes("\n")) span.inlineValue = [vs, ve];
    }
    return span;
  });
}

/** `key: value` lines for one pair, without a trailing newline. */
const renderPair = (key: string, value: unknown, indentSeq = false) => dumpYaml({ [key]: value }, { indentSeq }).trimEnd();

/** Whether a block indents its sequence items under the key (`key:\n  - x`). */
const usesIndentedSeq = (block: string) => /\n[ \t]+- /.test(block) && !/\n- /.test(block);

/** A scalar's inline text, or null if it needs more than one line. */
function inlineScalar(value: unknown): string | null {
  if (value !== null && typeof value === "object") return null;
  const text = dumpYaml(value).trimEnd();
  return text.includes("\n") ? null : text;
}

function insertionOffset(spans: PairSpan[], key: string, yamlLength: number): number {
  const order = FRONTMATTER_ORDER as readonly string[];
  const rank = order.indexOf(key);
  if (rank === -1) return spans.length ? spans[spans.length - 1]!.end : 0; // non-canonical: append
  let after: PairSpan | undefined;
  for (const span of spans) {
    const r = order.indexOf(span.key);
    if (r !== -1 && r < rank && (!after || span.start > after.start)) after = span;
  }
  if (after) return after.end;
  // Nothing canonical precedes it: go before the first canonical key that follows.
  const before = spans.find((s) => {
    const r = order.indexOf(s.key);
    return r !== -1 && r > rank;
  });
  return before ? before.start : yamlLength;
}

function editYaml(yaml: string, key: string, value: unknown): string {
  const spans = pairSpans(yaml);
  const existing = spans.find((s) => s.key === key);

  if (value === undefined) {
    if (!existing) return yaml;
    return yaml.slice(0, existing.start) + yaml.slice(existing.end);
  }

  if (existing) {
    const inline = inlineScalar(value);
    if (existing.inlineValue && inline !== null) {
      const [vs, ve] = existing.inlineValue;
      return yaml.slice(0, vs) + inline + yaml.slice(ve);
    }
    const block = yaml.slice(existing.start, existing.end);
    const keepNewline = block.endsWith("\n");
    // Keep the file's list style when a block value is rewritten.
    return yaml.slice(0, existing.start) + renderPair(key, value, usesIndentedSeq(block)) + (keepNewline ? "\n" : "") + yaml.slice(existing.end);
  }

  const at = insertionOffset(spans, key, yaml.length);
  const before = yaml.slice(0, at);
  const after = yaml.slice(at);
  const lead = before.length && !before.endsWith("\n") ? "\n" : "";
  const trail = after.length ? "\n" : "";
  return before + lead + renderPair(key, value) + trail + after;
}

/**
 * Apply top-level frontmatter updates to a concept file. A value of
 * `undefined` deletes the key. Creates a frontmatter block if the file has
 * none. Throws WriteError if the file cannot be edited safely.
 */
export function updateFrontmatter(text: string, updates: Record<string, unknown>): string {
  if (text.includes("\r\n")) throw new WriteError("File uses CRLF line endings; convert to LF first");
  const parts = split(text) ?? { head: "---\n", yaml: "", tail: `\n---\n${text}` };
  const original = parts.yaml === "" ? {} : parseMarkdown(text).frontmatter;

  let yaml = parts.yaml;
  for (const [key, value] of Object.entries(updates)) yaml = editYaml(yaml, key, value);
  if (yaml.endsWith("\n")) yaml = yaml.slice(0, -1);
  const result = parts.head + yaml + parts.tail;

  // Verify: exactly the intended frontmatter, body untouched.
  const expected: Frontmatter = { ...original };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete expected[key];
    else expected[key] = JSON.parse(JSON.stringify(value)) as unknown;
  }
  let actual: { frontmatter: Frontmatter; body: string };
  try {
    actual = parseMarkdown(result);
  } catch (err) {
    throw new WriteError(`Edit would break the frontmatter: ${(err as Error).message}`);
  }
  if (JSON.stringify(sortKeys(actual.frontmatter)) !== JSON.stringify(sortKeys(expected))) {
    throw new WriteError("Edit would change values other than the ones requested");
  }
  return result;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/**
 * Set a nested scalar (e.g. ["relationships", 0, "target"]) by splicing just
 * that value's text. Falls back to rewriting the top-level key when the path
 * does not end at an existing inline scalar.
 */
export function setScalarIn(text: string, path: Array<string | number>, value: string | number | boolean | null): string {
  const parts = split(text);
  if (!parts || path.length < 2) return updateFrontmatter(text, { [String(path[0])]: setPath(parseMarkdown(text).frontmatter, path, value)[String(path[0])] });
  const doc = parseDocument(parts.yaml, LOAD_OPTIONS);
  const node = doc.getIn(path, true);
  const inline = inlineScalar(value);
  const fm = parseMarkdown(text).frontmatter;
  const expected = setPath(fm, path, value);
  if (isScalar(node) && node.range && node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED" && inline !== null
    && !parts.yaml.slice(node.range[0], node.range[1]).includes("\n")) {
    const yaml = parts.yaml.slice(0, node.range[0]) + inline + parts.yaml.slice(node.range[1]);
    const result = parts.head + yaml + parts.tail;
    if (JSON.stringify(sortKeys(parseMarkdown(result).frontmatter)) !== JSON.stringify(sortKeys(expected))) {
      throw new WriteError("Edit would change values other than the ones requested");
    }
    return result;
  }
  const top = String(path[0]);
  return updateFrontmatter(text, { [top]: expected[top] });
}

function setPath(root: Frontmatter, path: Array<string | number>, value: unknown): Frontmatter {
  const clone = JSON.parse(JSON.stringify(root)) as Frontmatter;
  let cur: Record<string | number, unknown> = clone;
  for (const key of path.slice(0, -1)) {
    if (cur[key] === null || typeof cur[key] !== "object") cur[key] = typeof path[path.indexOf(key) + 1] === "number" ? [] : {};
    cur = cur[key] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]!] = value;
  return clone;
}

/** Replace CRLF line endings with LF (MIF tools reject CRLF). */
export const toLf = (text: string) => text.replace(/\r\n/g, "\n");

// --- line-level structural edits ------------------------------------------------

const lineStartOf = (t: string, i: number) => t.lastIndexOf("\n", i - 1) + 1;
const lineEndOf = (t: string, i: number) => {
  const nl = t.indexOf("\n", i);
  return nl === -1 ? t.length : nl + 1;
};

/** Indent a rendered YAML block by `n` spaces (all lines). */
const indentBlock = (block: string, n: number) => block.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

/**
 * Add a key to a nested block mapping, append an item to a block sequence,
 * or remove a nested pair / sequence item — by inserting or deleting whole
 * lines, so siblings keep their exact formatting (quotes, styles, comments).
 * Returns null when the structure is not plain block YAML; callers then fall
 * back to rewriting the top-level key.
 *   value === undefined → remove `path`
 *   path ends in an index equal to the sequence length → append
 *   otherwise → add a key that does not exist yet
 */
/**
 * New keys follow the file's quoting: when the frontmatter single-quotes
 * keys (`'@type':`) and never double-quotes them, so does the inserted text.
 */
export function matchKeyQuotes(rendered: string, yaml: string): string {
  if (!/^\s*(?:- )?'[^'\n]*':/m.test(yaml) || /^\s*(?:- )?"[^"\n]*":/m.test(yaml)) return rendered;
  return rendered.replace(/^(\s*(?:- )?)"([^"\\']*)":/gm, "$1'$2':");
}

export function editStructure(text: string, path: Array<string | number>, value: unknown): string | null {
  if (path.length < 2) return null;
  const parts = split(text);
  if (!parts) return null;
  const yaml = parts.yaml;
  const doc = parseDocument(yaml, LOAD_OPTIONS);
  if (doc.errors.length) return null;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = doc.getIn(parentPath, true);
  let next: string | null = null;

  if (isMap(parent) && !parent.flow && typeof last === "string") {
    const pairs = parent.items;
    const idx = pairs.findIndex((p) => isScalar(p.key) && p.key.value === last);
    if (value === undefined) {
      if (idx === -1) return null;
      const pair = pairs[idx]!;
      const kr = (pair.key as { range?: [number, number, number] }).range;
      const vr = isNode(pair.value) ? pair.value.range : undefined;
      if (!kr) return null;
      const end = lineEndOf(yaml, Math.max((vr?.[1] ?? kr[1]) - 1, kr[1]));
      next = yaml.slice(0, lineStartOf(yaml, kr[0])) + yaml.slice(end);
    } else {
      if (idx !== -1 || !pairs.length) return null;
      const first = (pairs[0]!.key as { range?: [number, number, number] }).range;
      const lastPair = pairs[pairs.length - 1]!;
      const lastEnd = isNode(lastPair.value) && lastPair.value.range ? lastPair.value.range[1] : (lastPair.key as { range?: number[] }).range?.[1];
      if (!first || lastEnd === undefined) return null;
      const indent = first[0] - lineStartOf(yaml, first[0]);
      const at = lineEndOf(yaml, lastEnd - 1);
      const rendered = matchKeyQuotes(indentBlock(dumpYaml({ [last]: value }, { indentSeq: false }).trimEnd(), indent), yaml);
      const before = yaml.slice(0, at);
      next = before + (before.endsWith("\n") ? "" : "\n") + rendered + (at < yaml.length ? "\n" : "") + yaml.slice(at);
    }
  } else if (isSeq(parent) && !parent.flow && typeof last === "number") {
    const items = parent.items;
    if (value === undefined) {
      const item = items[last];
      const r = isNode(item) ? item.range : undefined;
      if (!r) return null;
      const end = lineEndOf(yaml, Math.max(r[1] - 1, r[0]));
      next = yaml.slice(0, lineStartOf(yaml, r[0])) + yaml.slice(end);
    } else {
      if (last !== items.length || !items.length) return null;
      const firstR = isNode(items[0]) ? items[0].range : undefined;
      const lastItem = items[items.length - 1];
      const lastR = isNode(lastItem) ? lastItem.range : undefined;
      if (!firstR || !lastR) return null;
      const dash = yaml.lastIndexOf("-", firstR[0]);
      const indent = dash - lineStartOf(yaml, dash);
      const at = lineEndOf(yaml, lastR[1] - 1);
      const rendered = matchKeyQuotes(indentBlock(dumpYaml([value]).trimEnd(), indent), yaml);
      const before = yaml.slice(0, at);
      next = before + (before.endsWith("\n") ? "" : "\n") + rendered + (at < yaml.length ? "\n" : "") + yaml.slice(at);
    }
  }
  if (next === null) return null;
  if (next.endsWith("\n")) next = next.slice(0, -1);
  const result = parts.head + next + parts.tail;

  // Verify against the intended frontmatter; otherwise let the caller fall back.
  const fm = parseMarkdown(text).frontmatter;
  const expected = JSON.parse(JSON.stringify(fm)) as Frontmatter;
  let cur: Record<string | number, unknown> = expected;
  for (const k of parentPath) cur = cur[k] as Record<string | number, unknown>;
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(last as number, 1);
    else delete cur[last];
  } else cur[last] = JSON.parse(JSON.stringify(value));
  try {
    if (JSON.stringify(sortKeys(parseMarkdown(result).frontmatter)) !== JSON.stringify(sortKeys(expected))) return null;
  } catch {
    return null;
  }
  return result;
}
