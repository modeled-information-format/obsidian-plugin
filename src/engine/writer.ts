// Format-preserving frontmatter edits.
//
// Obsidian's processFrontMatter re-serializes the whole block and changes
// MIF values on the way. This writer splices text
// instead: only the bytes of the edited key change, new keys go in at their
// canonical position (FRONTMATTER_ORDER), and every result is re-parsed and
// compared with the intended frontmatter before it is returned. An edit that
// would disturb any other value throws instead of writing.

import { isMap, isNode, isScalar, parseDocument, type Pair } from "yaml";

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
const renderPair = (key: string, value: unknown) => dumpYaml({ [key]: value }).trimEnd();

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
    const keepNewline = yaml.slice(existing.start, existing.end).endsWith("\n");
    return yaml.slice(0, existing.start) + renderPair(key, value) + (keepNewline ? "\n" : "") + yaml.slice(existing.end);
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

/** Replace CRLF line endings with LF. */
export const toLf = (text: string) => text.replace(/\r\n/g, "\n");
