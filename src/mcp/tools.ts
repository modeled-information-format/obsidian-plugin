// The MCP tool layer: three read tools over a McpHost (Phase 0 of
// docs/PLAN-mcp.md). No Obsidian import; the SDK calls `createServer` once
// per HTTP request, so nothing here keeps state between calls.
//
// Guidance rule (plan M15): a client may never read the server's
// instructions, so each tool description carries its own workflow, each
// result states its weighing in words, and each error names the next step.
//
// Lists are compact by default (owner decision, plan M29): one line per
// item, with a concept's weighing stated only where it calls for caution.
// `detail: "full"` states every concept's weighing in full, and reading a
// single concept always does (plan M8). Every view of a concept counts
// its relationships by type and direction, so an agent can see which
// relationships point at it without listing them. Concepts a result names
// are also returned as resource links to their canonical ids (plan M16).

import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { registerCatalogTools } from "./catalog";
import { TASKS_EXTENSION, type TaskStore } from "./tasks";
import { registerExtras } from "./extras";
import { registerWriteTools } from "./write";
import type { ConceptRef, ConceptView, EdgeView, McpHost, SearchHit, Weighing } from "./host";

export const SERVER_NAME = "mif-vault";

/**
 * Every tool this server registers, in the order `tools/list` returns them.
 * The `mif_vault_` prefix keeps them apart from mif-rs's mif-mcp and
 * mif-rh-mcp servers (plan M24); tests/mcp.test.ts checks both lists.
 */
export const TOOL_NAMES = ["mif_vault_search_concepts", "mif_vault_get_concept", "mif_vault_list_relationships", "mif_vault_list_concepts", "mif_vault_list_entities", "mif_vault_get_status", "mif_vault_list_entity_types"] as const;

/** Responses stay under this many characters by returning fewer items, never by cutting text. */
export const CHARACTER_LIMIT = 25_000;
/** A passage in a search result is shortened to this unless detail is "full". */
export const SNIPPET = 280;
/** A concept's text is cut to this unless max_chars says otherwise; the result says so and lists the headings. */
export const DEFAULT_BODY = 8_000;
/** Concepts one relationships call may start from. */
export const MAX_STARTS = 25;
/** Hops a shortest-chain search follows before giving up. */
export const MAX_CHAIN = 6;

const CAUTION: Record<string, string> = {
  stale: "Caution: this concept is stale. Check it against a newer source before relying on it.",
  expired: "Caution: this concept has expired. Treat it as history, not as current fact.",
  "not-yet-valid": "Caution: this concept is not valid yet at the date asked about.",
};
export const cautious = (w: Weighing | undefined) => !!w && w.freshness in CAUTION;
export const hidden = (w: Weighing | undefined) => !!w && (w.freshness === "expired" || w.freshness === "not-yet-valid");

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('"markdown" for reading, with freshness, trust and what to do next in words; "json" for the same data as JSON text, for a program.');
export const detail = z
  .enum(["compact", "full"])
  .default("compact")
  .describe('"compact" (the default) gives one short line per concept and states freshness and trust only where a concept calls for caution; "full" states freshness, strength, trust, provenance, conformance level and open diagnostics for every concept, with its id and path.');
export const asOf = z
  .string()
  .optional()
  .describe('Judge freshness at this ISO 8601 date or date-time instead of now, e.g. "2026-06-01". Use it to ask what was valid on a past date.');
export const conceptArg = z
  .string()
  .min(1)
  .describe('The concept: its vault path ("semantic/rate-limit-policy.md"), its id ("urn:mif:<uuid>"), or its title or a code in its title ("CON-P-92"). If several concepts match, the error lists them.');

export const weighingSchema = z.object({
  freshness: z.string(),
  strength: z.number().optional(),
  expires_at: z.string().optional(),
  trust: z.string().optional(),
  source_type: z.string().optional(),
  level: z.number(),
  errors: z.number(),
  warnings: z.number(),
});
export const refSchema = z.object({
  id: z.string().optional(),
  path: z.string(),
  bundle: z.string(),
  title: z.string(),
  type: z.string().optional(),
});
export const countsSchema = z.object({ outgoing: z.record(z.string(), z.number()), incoming: z.record(z.string(), z.number()) });
export const page = { total_count: z.number(), count: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional() };

export type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "resource_link"; uri: string; name: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export type Counts = { outgoing: Record<string, number>; incoming: Record<string, number> };

export const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

export function parseAsOf(value: string | undefined): Date | string {
  if (value === undefined) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? `as_of "${value}" is not a date. Use ISO 8601, for example "2026-06-01" or "2026-06-01T12:00:00Z".` : d;
}

export function weighingLine(w: Weighing): string {
  const parts = [`freshness: ${w.freshness}${w.strength === undefined ? "" : ` (strength ${w.strength.toFixed(2)})`}`];
  if (w.expires_at) parts.push(`expires ${w.expires_at}`);
  parts.push(`trust: ${w.trust ?? "not recorded"}`);
  if (w.source_type) parts.push(`source: ${w.source_type}`);
  parts.push(`MIF level ${w.level}`);
  if (w.errors || w.warnings) parts.push(`${w.errors} error(s), ${w.warnings} warning(s)`);
  const caution = CAUTION[w.freshness];
  return parts.join(" · ") + (caution ? `\n${caution}` : "");
}

/** Freshness and trust in a few words, for a line in a list. */
export const weighingBrief = (w: Weighing) => `${w.freshness}, trust ${w.trust ?? "not recorded"}`;

export const refOf = (c: ConceptRef): ConceptRef => ({ ...(c.id ? { id: c.id } : {}), path: c.path, bundle: c.bundle, title: c.title, ...(c.type ? { type: c.type } : {}) });
export const refLine = (c: ConceptRef, full = true) => (full ? `${c.title} (${c.id ?? "no id"}, ${c.path})` : `${c.title} [${c.path}]`);

/** How many relationships of each type a concept declares (outgoing) and has pointing at it (incoming). */
/** Quote marks a client left on an argument it split out of a quoted phrase. */
export const unquote = (v: string) => v.replace(/^["'\s]+|["'\s]+$/g, "");

/**
 * For a prompt that takes free text. A client that runs a prompt as a typed command may pass only
 * the first word of what was typed (Claude Code does, quotes or not), and the server cannot see the
 * rest; the model can, because the client shows it the command as typed.
 */
export const typedInFull = (what: string) =>
  `If this prompt was run as a typed command and more was typed after the command than appears above, the client cut it short: take everything that was typed as ${what}.`;

export function countEdges(edges: EdgeView[]): Counts {
  const counts: Counts = { outgoing: {}, incoming: {} };
  for (const e of edges) counts[e.direction][e.type] = (counts[e.direction][e.type] ?? 0) + 1;
  return counts;
}

export function countsLine(counts: Counts): string {
  const side = (c: Record<string, number>) =>
    Object.entries(c)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, n]) => `${type} ${n}`)
      .join(", ") || "none";
  return `Relationships it declares (outgoing): ${side(counts.outgoing)}. Relationships other concepts declare to it (incoming): ${side(counts.incoming)}.`;
}

/** The same counts in a few words, for a line in a list. */
export function countsBrief(counts: Counts): string {
  const side = (c: Record<string, number>) =>
    Object.entries(c)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, n]) => `${type} ${n}`)
      .join(", ") || "none";
  return `declares: ${side(counts.outgoing)}; declared to it: ${side(counts.incoming)}`;
}

/** The part of a markdown body under one heading, to the next heading of the same or a higher level. */
export function sectionOf(body: string, heading: string): string | undefined {
  const lines = body.split("\n");
  const want = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]!);
    if (!m || m[2]!.toLowerCase() !== want) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s/.exec(lines[end]!);
      if (next && next[1]!.length <= m[1]!.length) break;
      end++;
    }
    found.push(lines.slice(i, end).join("\n").trimEnd());
  }
  return found.length ? found.join("\n\n") : undefined;
}

const headingsOf = (body: string) => body.split("\n").flatMap((l) => (/^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)?.[1] ?? [])).filter(Boolean);

export function resolveOrFail(host: McpHost, ref: string, at: Date): ConceptView | ToolResult {
  const r = host.resolve(ref, at);
  if ("concept" in r) return r.concept;
  if ("ambiguous" in r) return fail(`"${ref}" matches more than one concept. Call again with one of these paths:\n${r.ambiguous.map((a) => `- ${a}`).join("\n")}`);
  return fail(`No concept found for "${ref}". Pass a vault path, an id, or a title or code from a title; or use ${TOOL_NAMES[0]} to find it by meaning.`);
}

/**
 * Fit `items` under CHARACTER_LIMIT by dropping from the end; the page's
 * next_offset then points at the first item left out.
 */
export function fit<T, P extends Record<string, unknown>>(items: T[], total: number, offset: number, more: boolean, build: (items: T[], page: { total_count: number; count: number; offset: number; has_more: boolean; next_offset?: number }) => { data: P; text: string }) {
  let kept = items;
  for (;;) {
    const has_more = more || kept.length < items.length || offset + kept.length < total;
    const out = build(kept, { total_count: total, count: kept.length, offset, has_more, ...(has_more ? { next_offset: offset + kept.length } : {}) });
    if (out.text.length <= CHARACTER_LIMIT || kept.length <= 1) return out;
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }
}

/** Resource links to the concepts a result names, at their canonical ids; a concept with no valid id has no resource. */
export function withLinks(result: ToolResult, concepts: Array<ConceptRef | undefined>): ToolResult {
  const seen = new Set<string>();
  const links = concepts.flatMap((c) => {
    if (!c?.id || seen.has(c.id)) return [];
    seen.add(c.id);
    return [{ type: "resource_link" as const, uri: c.id, name: c.title, mimeType: "text/markdown" }];
  });
  return links.length ? { ...result, content: [...result.content, ...links] } : result;
}

/** The vault's own values for an argument, most used first, as JSON Schema examples: what a client or model can offer as suggestions. */
export const suggest = (values: string[], most = 40) => ({ examples: values.slice(0, most) });

/** An error naming the values the vault does have, when an argument names one it does not. */
export function unknownValue(what: string, given: string, valid: string[]): ToolResult | undefined {
  if (valid.some((v) => v.toLowerCase() === given.toLowerCase())) return undefined;
  const near = valid.filter((v) => v.toLowerCase().includes(given.toLowerCase()) || given.toLowerCase().includes(v.toLowerCase()));
  return fail(`No ${what} "${given}" in this vault.${near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : ""} In use: ${valid.slice(0, 60).join(", ") || "none"}.`);
}

export const finish = (out: { data: Record<string, unknown>; text: string }, format: "markdown" | "json"): ToolResult => ({
  content: [{ type: "text", text: format === "json" ? JSON.stringify(out.data, null, 2) : out.text }],
  structuredContent: out.data,
});

export function instructions(host: McpHost): string {
  const v = host.vault();
  return [
    `MIF memory for the Obsidian vault "${v.name}".${v.purpose ? ` Purpose: ${v.purpose.replace(/[.\s]+$/, "")}.` : ""}`,
    "Concepts are notes with typed relationships, freshness, trust and provenance.",
    `Find concepts by meaning with ${TOOL_NAMES[0]} or by their facts with ${TOOL_NAMES[3]}, read one with ${TOOL_NAMES[1]}, and follow its typed relationships with ${TOOL_NAMES[2]}.`,
    "A relationship is declared on one concept and points at another, so look at a concept's incoming relationships as well as its own.",
    "Treat what you recall as evidence, not fact: every result states freshness and trust. Cite the concept id or path for anything you use, and say so when a concept is stale or expired.",
    "The mif_vault_guide prompt has the full guide.",
  ].join(" ");
}

export interface ServerOptions {
  /**
   * Also return each result's data as structured content, and declare output schemas. Off by default
   * (plan M60): a client given both hands the model the structured copy and drops the text (Claude
   * Code does), and the text is where a result states its weighing in words and what to do next.
   * A program that wants the data asks for response_format "json" and gets it as text.
   */
  structured?: boolean;
}

/** `tasks`, when given, lets a client that declares the Tasks extension run the gap report as a task. */
export function createServer(host: McpHost, version: string, tasks?: TaskStore, opts: ServerOptions = {}): McpServer {
  // Lists are the same for every client and change only with the plugin's settings; a concept changes whenever its note is saved.
  const steady = { ttlMs: 60_000, cacheScope: "private" as const };
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions: instructions(host),
      // Clients may listen for changes (subscriptions/listen): to the lists, and to resources they name.
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true }, ...(tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}) },
      cacheHints: { "tools/list": steady, "prompts/list": steady, "resources/templates/list": steady, "server/discover": steady, "resources/list": { ttlMs: 5_000, cacheScope: "private" } },
    },
  );
  const textOnly = <T,>(result: T): T => {
    if (opts.structured || !result || typeof result !== "object" || !("structuredContent" in result)) return result;
    const { structuredContent: _data, ...rest } = result as Record<string, unknown>;
    return rest as T;
  };
  if (!opts.structured) {
    // Every tool is registered through here, so one place decides the shape of every result.
    type Register = (name: string, config: Record<string, unknown>, cb: (...a: unknown[]) => unknown) => unknown;
    const untyped = server as unknown as { registerTool: Register };
    const register = untyped.registerTool.bind(server);
    untyped.registerTool = (name, config, cb) => {
      const { outputSchema: _schema, ...rest } = config;
      return register(name, rest, async (...a) => textOnly(await cb(...a)));
    };
  }
  if (tasks) {
    // A tool with an output schema must return structured content, and the SDK (2.4.0) knows no task result:
    // let one through unchecked. This leans on an SDK method that is not part of its documented surface;
    // the task test fails if a release changes it.
    const checked = server as unknown as { validateToolOutput(tool: unknown, result: unknown, name: string): Promise<void> };
    const validate = checked.validateToolOutput.bind(server);
    checked.validateToolOutput = async (tool, result, name) => {
      if ((result as { resultType?: unknown } | undefined)?.resultType === "task") return;
      return validate(tool, result, name);
    };
    // The Tasks extension's own methods. There is no tasks/list (the extension has none), and no tasks/update: no task here asks for input.
    const params = z.object({ taskId: z.string().min(1) }).loose();
    const result = z.object({}).loose();
    const unknown = () => new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown or expired task.");
    server.server.setRequestHandler("tasks/get", { params, result }, (p) => {
      const task = tasks.get(p.taskId);
      if (!task) throw unknown();
      return { ...task, ...(task.result === undefined ? {} : { result: textOnly(task.result) }) };
    });
    server.server.setRequestHandler("tasks/cancel", { params, result }, (p) => {
      if (!tasks.cancel(p.taskId)) throw unknown();
      return {};
    });
  }
  const vocab = host.vocabulary();

  server.registerTool(
    TOOL_NAMES[0],
    {
      title: "Search MIF concepts",
      description:
        "Search this Obsidian vault's MIF concepts by meaning and exact terms, and get the passage that matched; or pass similar_to for the concepts nearest in meaning to one you name. " +
        "To check for a duplicate before writing something down, search its title or text with mode \"semantic\" and min_cosine set to the duplicate threshold the result reports. " +
        "Use this to find concepts on a topic. If you already know a concept's title or a code in it, skip the search: " +
        `${TOOL_NAMES[1]} and ${TOOL_NAMES[2]} accept a title or code directly. ` +
        "Results are evidence, not fact: each one states its freshness and trust, and expired concepts are left out unless include_expired is true. " +
        "Cite the path or id of what you use. Needs the bundle to have been ingested into its vector store in Obsidian.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000).optional().describe('What to look for, in natural language or exact terms, e.g. "rate limit policy for the public API". Give this or similar_to.'),
        similar_to: z.string().min(1).optional().describe("A concept (path, id, title or code): return the concepts nearest to it in meaning, in place of a query."),
        min_cosine: z.number().min(0).max(1).optional().describe("Leave out results whose cosine similarity is below this, e.g. the vault's duplicate threshold."),
        mode: z.enum(["hybrid", "semantic"]).default("hybrid").describe('"hybrid" ranks by meaning and exact terms together (finds identifiers); "semantic" ranks by meaning alone.'),
        entity_type: z.string().optional().describe('Only concepts whose entity type is exactly this, e.g. "how-to-guide". The examples are the entity types this vault uses.').meta(suggest(vocab.entity_types)),
        folder: z.string().optional().describe('Only concepts in this vault folder or below it, e.g. "procedural". The examples are this vault\'s top folders.').meta(suggest(vocab.folders)),
        bundle: z.string().optional().describe('Only this bundle root; omit to search every bundle. "" is the vault root. The examples are this vault\'s bundles.').meta(suggest(vocab.bundles)),
        include_expired: z.boolean().default(false).describe("Also return concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).default(10).describe("Maximum results to return; at most 50, and a larger number is treated as 50."),
        offset: z.number().int().min(0).default(0).describe("Results to skip, for the next page."),
        detail: detail.describe('"compact" (the default) shortens each matching passage and its weighing; "full" returns the passage whole, with the concept\'s id and full weighing.'),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        ...page,
        excluded_expired: z.number(),
        thresholds: z.object({ duplicate: z.number(), similar: z.number(), mislink: z.number() }),
        results: z.array(
          z.object({
            id: z.string(),
            concept: refSchema.optional(),
            title: z.string().optional(),
            cosine: z.number().optional(),
            heading: z.string().optional(),
            passage: z.string().optional(),
            weighing: weighingSchema.optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      const bundles = host.vault().bundles;
      if (args.bundle !== undefined && !bundles.includes(args.bundle)) return fail(`No bundle "${args.bundle}". Bundles in this vault: ${bundles.map((b) => `"${b}"`).join(", ")}.`);
      if (args.entity_type !== undefined) {
        const bad = unknownValue("entity type", args.entity_type, vocab.entity_types);
        if (bad) return bad;
      }
      const targets = args.bundle === undefined ? bundles : [args.bundle];
      const limit = Math.min(args.limit, 50);
      const want = args.offset + limit + 1;
      const full = args.detail === "full";
      let hits: SearchHit[] = [];
      const problems: string[] = [];
      if ((args.query === undefined) === (args.similar_to === undefined)) return fail("Give exactly one of query (what to look for) or similar_to (a concept to find neighbours of).");
      let subject = `"${args.query}"`;
      if (args.similar_to !== undefined) {
        const anchor = resolveOrFail(host, args.similar_to, at);
        if ("content" in anchor) return anchor;
        subject = `concepts similar to ${anchor.title}`;
        const r = await host.similar(anchor.path, want);
        if (Array.isArray(r)) hits = r.filter((h) => h.concept?.path !== anchor.path);
        else problems.push(r.unavailable);
      } else {
        for (const bundle of targets) {
          const r = await host.search({ query: args.query!, bundle, limit: want, semantic: args.mode === "semantic", entityType: args.entity_type, folder: args.folder });
          if (Array.isArray(r)) hits.push(...r);
          else problems.push(targets.length > 1 ? `bundle "${bundle}": ${r.unavailable}` : r.unavailable);
        }
      }
      if (args.min_cosine !== undefined) hits = hits.filter((h) => (h.cosine ?? 0) >= args.min_cosine!);
      const thresholds = host.thresholds();
      if (hits.length === 0 && problems.length) {
        return fail(`Search is unavailable. ${problems.join(" ")} Until then, read a concept by its title or path with ${TOOL_NAMES[1]} and follow ${TOOL_NAMES[2]}, or ask the user to ingest the bundle in Obsidian.`);
      }
      // One store keeps mif-cli's own ranking; several are merged by cosine, the only score comparable across stores.
      if (targets.length > 1 && args.similar_to === undefined) hits.sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1));
      let excluded = 0;
      const weighed = hits.flatMap((h) => {
        const weighing = h.concept ? host.weigh(h.concept.path, at) : undefined;
        if (!args.include_expired && hidden(weighing)) {
          excluded++;
          return [];
        }
        return [{ ...h, weighing }];
      });
      const window = weighed.slice(args.offset, args.offset + limit);
      const more = weighed.length > args.offset + limit;
      const out = fit(window, Math.max(weighed.length, args.offset + window.length), args.offset, more, (items, p) => {
        const results = items.map((h) => {
          const passage = h.passage?.replace(/\s+/g, " ").trim();
          const shown = passage && !full && passage.length > SNIPPET ? `${passage.slice(0, SNIPPET).trimEnd()}…` : passage;
          return {
            id: h.id,
            ...(h.concept ? { concept: refOf(h.concept) } : {}),
            ...(h.title ? { title: h.title } : {}),
            ...(h.cosine === undefined ? {} : { cosine: h.cosine }),
            ...(h.heading ? { heading: h.heading } : {}),
            ...(shown ? { passage: shown } : {}),
            ...(h.weighing ? { weighing: h.weighing } : {}),
          };
        });
        const lines = results.map((r, i) =>
          [
            `${p.offset + i + 1}. ${r.concept ? refLine(r.concept, full) : `${r.title ?? "(not in the vault)"} (${r.id})`}${r.cosine === undefined ? "" : ` — cosine ${r.cosine.toFixed(2)}`}`,
            r.weighing ? `   ${(full || cautious(r.weighing) ? weighingLine(r.weighing) : weighingBrief(r.weighing)).replace(/\n/g, "\n   ")}` : "   Not in the vault any more: the store holds a document whose note is gone.",
            r.passage ? `   ${r.heading ? `Under "${r.heading}": ` : ""}${r.passage}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        const notes = [
          excluded ? `${excluded} expired or not-yet-valid concept(s) left out; pass include_expired: true to see them.` : "",
          problems.length ? `Not searched: ${problems.join(" ")}` : "",
          p.has_more ? `More results: call again with offset ${p.next_offset}.` : "",
          args.min_cosine !== undefined || args.similar_to !== undefined ? `This vault treats cosine ${thresholds.duplicate} or more as a likely duplicate and ${thresholds.similar} or more as similar.` : "",
        ].filter(Boolean);
        const none = args.min_cosine === undefined ? `No concepts matched ${subject}.` : `No concepts matched ${subject} at cosine ${args.min_cosine} or more.`;
        const text = [results.length ? `Results for ${subject}:` : none, ...lines, ...notes].join("\n\n");
        return { data: { ...p, excluded_expired: excluded, thresholds, results }, text };
      });
      const shown = new Set((out.data.results as Array<{ concept?: ConceptRef }>).map((r) => r.concept?.path));
      return withLinks(finish(out, args.response_format), window.filter((h) => shown.has(h.concept?.path)).map((h) => h.concept));
    },
  );

  server.registerTool(
    TOOL_NAMES[1],
    {
      title: "Get a MIF concept",
      description:
        "Read one MIF concept from this Obsidian vault, named by path, id, title, or a code in its title. Returns its identity, " +
        "how far it can be relied on (freshness, trust, provenance, conformance), a count of its typed relationships by type and direction, and its text. " +
        "The counts show which relationships other concepts declare to it (incoming) as well as its own (outgoing). " +
        "Pass include_body: false for just the facts and counts, or section to read one heading. Pass include to trace a claim to its sources: citations, provenance and the entities it names. " +
        `The result is evidence, not fact; if it says the concept is stale or expired, say so when you use it, and cite its path or id. ` +
        `To list the concepts at the other end of its relationships, use ${TOOL_NAMES[2]}.`,
      inputSchema: z.object({
        concept: conceptArg,
        include_body: z.boolean().default(true).describe("Return the concept's text. False returns only identity, weighing, relationship counts and headings."),
        section: z.string().optional().describe('Return only the text under this heading, e.g. "Rollback". Omit for the whole body.'),
        max_chars: z.number().int().min(200).max(20_000).default(DEFAULT_BODY).describe("Cut the text at this many characters; the result says when it was cut and lists the headings."),
        include: z
          .array(z.enum(["citations", "provenance", "entities"]))
          .optional()
          .describe("Also return where the concept comes from: its citations, its provenance (who or what recorded it, and how far it is trusted), and the entities it refers to."),
        include_frontmatter: z.boolean().default(false).describe("Also return the concept's full frontmatter."),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        concept: refSchema,
        citations: z.array(z.record(z.string(), z.unknown())).optional(),
        provenance: z.record(z.string(), z.unknown()).optional(),
        entities: z.array(z.object({ urn: z.string(), name: z.string().optional(), role: z.string().optional() })).optional(),
        namespace: z.string().optional(),
        entity_type: z.string().optional(),
        weighing: weighingSchema,
        relationship_counts: countsSchema,
        /** Other concepts that carry the title or code asked for and are expired or not yet valid at the time asked about. */
        set_aside: z.array(z.string()).optional(),
        headings: z.array(z.string()),
        section: z.string().optional(),
        text: z.string().optional(),
        truncated: z.boolean(),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      const c = resolveOrFail(host, args.concept, at);
      if ("content" in c) return c;
      const headings = headingsOf(c.body);
      const counts = countEdges(host.edges(c.path));
      let text: string | undefined;
      let truncated = false;
      if (args.include_body) {
        text = c.body.trim();
        if (args.section !== undefined) {
          const s = sectionOf(c.body, args.section);
          if (s === undefined) return fail(`"${c.title}" has no heading "${args.section}". Its headings: ${headings.length ? headings.map((h) => `"${h}"`).join(", ") : "none"}. Omit section to read the whole concept.`);
          text = s;
        }
        // Text over the limit is not cut silently: say so, and point at sections.
        const room = Math.max(200, Math.min(args.max_chars, CHARACTER_LIMIT - 2_000 - (args.include_frontmatter ? JSON.stringify(c.frontmatter).length : 0)));
        truncated = text.length > room;
        if (truncated) text = text.slice(0, room);
      }
      const want = new Set(args.include ?? []);
      const fm = c.frontmatter;
      const records = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
      const citations = want.has("citations") ? records(fm.citations) : undefined;
      const provenance = want.has("provenance") ? (fm.provenance && typeof fm.provenance === "object" && !Array.isArray(fm.provenance) ? (fm.provenance as Record<string, unknown>) : {}) : undefined;
      const entities = want.has("entities")
        ? records(fm.entities).flatMap((e) => {
            const urn = (e.entity as { "@id"?: unknown } | undefined)?.["@id"];
            return typeof urn === "string" ? [{ urn, ...(typeof e.name === "string" ? { name: e.name } : {}), ...(typeof e.role === "string" ? { role: e.role } : {}) }] : [];
          })
        : undefined;
      const word = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
      const sourceLines = [
        citations ? (citations.length ? `Citations (${citations.length}):\n${citations.map((x) => `  - ${[word(x.title), word(x.citationType), word(x.citationRole), word(x.url), word(x.accessed)].filter(Boolean).join(" · ")}`).join("\n")}` : "Citations: none recorded.") : "",
        provenance ? (Object.keys(provenance).length ? `Provenance: ${Object.entries(provenance).filter(([k]) => k !== "@type").map(([k, v]) => `${k} ${word(v) ?? JSON.stringify(v)}`).join("; ")}` : "Provenance: none recorded.") : "",
        entities ? (entities.length ? `Entities (${entities.length}):\n${entities.map((x) => `  - ${x.name ?? x.urn}${x.role ? ` (${x.role})` : ""} — ${x.urn}`).join("\n")}` : "Entities: none referenced.") : "",
      ].filter(Boolean);
      const data = {
        concept: refOf(c),
        ...(citations ? { citations } : {}),
        ...(provenance ? { provenance } : {}),
        ...(entities ? { entities } : {}),
        ...(c.namespace ? { namespace: c.namespace } : {}),
        ...(c.entity_type ? { entity_type: c.entity_type } : {}),
        weighing: c.weighing,
        relationship_counts: counts,
        ...(c.set_aside?.length ? { set_aside: c.set_aside } : {}),
        headings,
        ...(args.section === undefined ? {} : { section: args.section }),
        ...(text === undefined ? {} : { text }),
        truncated,
        ...(args.include_frontmatter ? { frontmatter: c.frontmatter } : {}),
      };
      const md = [
        `# ${c.title}`,
        `${c.id ?? "no id"} · ${c.path}${c.type ? ` · ${c.type}` : ""}${c.namespace ? ` · ${c.namespace}` : ""}${c.entity_type ? ` · ${c.entity_type}` : ""}`,
        weighingLine(c.weighing),
        countsLine(counts),
        c.set_aside?.length ? `${c.set_aside.length} other concept(s) carry this title or code and are expired or not yet valid at the time asked about, so this one was taken as meant: ${c.set_aside.join(", ")}. Pass as_of to ask about an earlier date, or a path to read one of them.` : "",
        ...sourceLines,
        c.id ? "" : "This note has no valid id, so it can only be addressed by its path.",
        args.include_frontmatter ? `Frontmatter:\n${JSON.stringify(c.frontmatter, null, 2)}` : "",
        text === undefined ? (headings.length ? `Headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "") : text,
        truncated ? `The text was cut at ${text!.length} characters. Read one section at a time with section, or raise max_chars; headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = finish({ data, text: md }, args.response_format);
      // A link to the concept itself at its canonical id, so a client can attach or re-read it.
      return withLinks(result, [c]);
    },
  );

  server.registerTool(
    TOOL_NAMES[2],
    {
      title: "List typed relationships",
      description:
        "List the typed relationships of one or several MIF concepts (each named by path, id, title, or a code in its title). " +
        "These are relationships an author declared (for example supersedes, depends-on, relates-to), not similarity. " +
        "Each relationship is declared on one concept and points at another: outgoing ones are declared by this concept, " +
        "incoming ones are declared by other concepts and point at it. A question such as \"what is briefed in X\" or " +
        "\"what is grounded in X\" is answered by X's incoming relationships of that type, so check both directions. " +
        "Do the work in one call where you can: pass several concepts with combine to get what they share (\"intersect\") or what the first has and the others lack (\"subtract\"); " +
        "pass path to follow a chain of relationship types hop by hop; pass path_to to find how two concepts are connected; pass neighbor_counts to see each related concept's own relationship counts, which compares siblings without a call for each. " +
        "The result starts with counts by type and direction; filter with types and direction to keep it short. " +
        `Treat what it returns as evidence and cite the concepts; concepts that have expired are left out unless include_expired is true. Read a related concept with ${TOOL_NAMES[1]}.`,
      inputSchema: z.object({
        concept: z
          .union([conceptArg, z.array(z.string().min(1)).min(1).max(MAX_STARTS)])
          .describe(`One concept, or a list of up to ${MAX_STARTS}: a vault path, an id ("urn:mif:<uuid>"), a title, or a code in a title ("CON-P-92"). If a name matches several concepts, the error lists them.`),
        combine: z
          .enum(["each", "intersect", "union", "subtract"])
          .default("each")
          .describe('With several concepts: "each" lists every concept\'s relationships; "intersect" returns the concepts related to all of them; "union" to any of them; "subtract" to the first but none of the others. The filters (types, direction) say which relationships count.'),
        depth: z.number().int().min(1).max(3).default(1).describe("How many hops to follow. 1 is the concept's own relationships. Ignored when path is given."),
        direction: z.enum(["both", "outgoing", "incoming"]).default("both").describe('"outgoing" for relationships the concept declares, "incoming" for those other concepts declare to it.'),
        types: z.array(z.string().meta(suggest(vocab.relationship_types))).optional().describe('Only these relationship types, e.g. ["supersedes", "depends-on"]. The examples are the relationship types this vault uses.'),
        path: z
          .array(z.object({ type: z.string().min(1).meta(suggest(vocab.relationship_types)), direction: z.enum(["outgoing", "incoming"]).default("outgoing") }))
          .min(1)
          .max(4)
          .optional()
          .describe('Follow one relationship type per hop, in order, e.g. [{"type":"constrains"},{"type":"part-of"}] for "what it constrains, then what those are part of". Replaces depth, types and direction.'),
        path_to: z.string().min(1).optional().describe("A second concept: return the shortest chain of typed relationships from the first concept to this one, following relationships in either direction (up to 6 hops). Narrow it with types."),
        neighbor_counts: z.boolean().default(false).describe("Add each related concept's own relationship counts by type and direction. Use it to compare the related concepts without a call for each."),
        counts_only: z.boolean().default(false).describe("Return only the counts by type and direction, without listing the relationships."),
        include_expired: z.boolean().default(false).describe("Also follow relationships to concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).default(50).describe("Maximum relationships to return; at most 100, and a larger number is treated as 100. Use counts_only for totals."),
        offset: z.number().int().min(0).default(0).describe("Relationships to skip, for the next page."),
        detail,
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        concepts: z.array(z.object({ concept: refSchema, relationship_counts: countsSchema })),
        combine: z.string(),
        ...page,
        excluded_expired: z.number(),
        types: z.array(z.string()),
        relationships: z.array(
          z.object({
            hop: z.number(),
            from: z.string(),
            type: z.string(),
            direction: z.enum(["outgoing", "incoming"]),
            target: z.string().optional(),
            path: z.string().optional(),
            title: z.string().optional(),
            id: z.string().optional(),
            strength: z.number().optional(),
            counts: countsSchema.optional(),
            weighing: weighingSchema.optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      for (const type of [...(args.types ?? []), ...(args.path ?? []).map((step) => step.type)]) {
        const bad = unknownValue("relationship type", type, vocab.relationship_types);
        if (bad) return bad;
      }
      const names = Array.isArray(args.concept) ? args.concept : [args.concept];
      const starts: ConceptView[] = [];
      for (const name of names) {
        const c = resolveOrFail(host, name, at);
        if ("content" in c) return c;
        if (!starts.some((s) => s.path === c.path)) starts.push(c);
      }
      const setMode = args.combine !== "each";
      if (setMode && starts.length < 2) return fail(`combine: "${args.combine}" needs at least two different concepts in concept; pass a list.`);
      if (setMode && args.path) return fail(`combine: "${args.combine}" compares each concept's own relationships and cannot be used with path. Use types and direction to say which relationships count.`);
      let goal: ConceptView | undefined;
      if (args.path_to !== undefined) {
        if (starts.length !== 1 || setMode || args.path) return fail("path_to finds the chain between two concepts: give one concept in concept, and do not combine it with combine or path.");
        const g = resolveOrFail(host, args.path_to, at);
        if ("content" in g) return g;
        goal = g;
      }
      const full = args.detail === "full";
      const unique = host.uniqueTitles();
      // A title that only one concept has is a complete handle: every tool accepts it in place of a path.
      const label = (c: ConceptRef) => (full ? refLine(c, true) : unique.has(c.title.toLowerCase()) ? c.title : refLine(c, false));
      const wanted = args.types ? new Set(args.types) : undefined;
      const hops = args.path ? args.path.length : setMode ? 1 : args.depth;
      const allows = (hop: number, edge: EdgeView) => {
        const step = args.path?.[hop - 1];
        if (step) return edge.type === step.type && edge.direction === step.direction;
        return (args.direction === "both" || edge.direction === args.direction) && (!wanted || wanted.has(edge.type));
      };

      type Row = { start: ConceptView; hop: number; from: ConceptRef; edge: EdgeView; weighing?: Weighing };
      let excluded = 0;
      const walk = (start: ConceptView): Row[] => {
        const rows: Row[] = [];
        const seen = new Set([start.path]);
        const listed = new Set<string>();
        let frontier: ConceptRef[] = [start];
        for (let hop = 1; hop <= hops && frontier.length; hop++) {
          const next: ConceptRef[] = [];
          for (const from of frontier) {
            for (const edge of host.edges(from.path)) {
              if (!allows(hop, edge)) continue;
              // An edge between two listed concepts is reached from both ends; list it once.
              const [a, b] = edge.direction === "outgoing" ? [from.path, edge.concept?.path ?? edge.target] : [edge.concept?.path ?? edge.target, from.path];
              const key = `${a}\u0000${edge.type}\u0000${b}`;
              if (listed.has(key)) continue;
              const weighing = edge.concept ? host.weigh(edge.concept.path, at) : undefined;
              if (!args.include_expired && hidden(weighing)) {
                excluded++;
                continue;
              }
              listed.add(key);
              rows.push({ start, hop, from, edge, weighing });
              if (edge.concept && !seen.has(edge.concept.path)) {
                seen.add(edge.concept.path);
                next.push(edge.concept);
              }
            }
          }
          frontier = next;
        }
        return rows;
      };

      // Counts cover every relationship of a concept, whatever the filters: they show what else is there.
      const summary = starts.map((s) => ({ concept: refOf(s), relationship_counts: countEdges(host.edges(s.path)) }));
      // Breadth first from the start, either direction, so the first time the goal is reached is a shortest chain.
      const chain = (start: ConceptView, to: ConceptView): Row[] | undefined => {
        if (start.path === to.path) return [];
        const came = new Map<string, Row>();
        const seen = new Set([start.path]);
        let frontier: ConceptRef[] = [start];
        for (let hop = 1; hop <= MAX_CHAIN && frontier.length; hop++) {
          const next: ConceptRef[] = [];
          for (const from of frontier) {
            for (const edge of host.edges(from.path)) {
              const other = edge.concept;
              if (!other || seen.has(other.path) || (wanted && !wanted.has(edge.type))) continue;
              const weighing = host.weigh(other.path, at);
              if (!args.include_expired && hidden(weighing)) continue;
              seen.add(other.path);
              came.set(other.path, { start, hop, from, edge, weighing });
              if (other.path === to.path) {
                const rows: Row[] = [];
                for (let step: string | undefined = to.path; step && step !== start.path; step = came.get(step)?.from.path) rows.unshift(came.get(step)!);
                return rows;
              }
              next.push(other);
            }
          }
          frontier = next;
        }
        return undefined;
      };
      const found = goal ? chain(starts[0]!, goal) : undefined;
      const walked = goal ? [found ?? []] : args.counts_only ? starts.map(() => [] as Row[]) : starts.map(walk);
      let rows: Row[];
      if (setMode) {
        // The concepts at the other end of each start's matching relationships, as sets of vault paths.
        const sets = walked.map((list) => new Map(list.flatMap((r) => (r.edge.concept ? [[r.edge.concept.path, r] as const] : []))));
        const [first, ...rest] = sets;
        const keep =
          args.combine === "intersect"
            ? [...first!.keys()].filter((p) => rest.every((s) => s.has(p)))
            : args.combine === "subtract"
              ? [...first!.keys()].filter((p) => !rest.some((s) => s.has(p)))
              : [...new Set(sets.flatMap((s) => [...s.keys()]))];
        rows = keep.map((p) => sets.find((s) => s.has(p))!.get(p)!);
      } else {
        rows = walked.flat();
      }

      const types = [...new Set(rows.map((r) => r.edge.type))].sort();
      const window = rows.slice(args.offset, args.offset + Math.min(args.limit, 100));
      const filtered = !!(wanted || args.direction !== "both" || args.path);
      const tallied =
        args.counts_only && !goal && !setMode
          ? summary.flatMap((c) => (["outgoing", "incoming"] as const).filter((d) => args.direction === "both" || args.direction === d).flatMap((d) => Object.entries(c.relationship_counts[d]).filter(([t]) => !wanted || wanted.has(t))))
          : undefined;
      const out = fit(window, rows.length, args.offset, false, (items, p) => {
        const relationships = items.map((r) => {
          const other = r.edge.concept;
          return {
            hop: r.hop,
            from: r.from.path,
            type: r.edge.type,
            direction: r.edge.direction,
            ...(other ? { path: other.path, title: other.title } : { target: r.edge.target }),
            ...(full && other?.id ? { id: other.id } : {}),
            ...(r.edge.strength === undefined ? {} : { strength: r.edge.strength }),
            ...(args.neighbor_counts && other ? { counts: countEdges(host.edges(other.path)) } : {}),
            ...(r.weighing && (full || cautious(r.weighing)) ? { weighing: r.weighing } : {}),
          };
        });
        const line = (r: Row, i: number) => {
          const rel = relationships[i]!;
          const other = r.edge.concept ? label(r.edge.concept) : `${r.edge.target} (not a concept in this bundle)`;
          const note = r.weighing && full ? `\n      ${weighingLine(r.weighing).replace(/\n/g, "\n      ")}` : cautious(r.weighing) ? ` — ${r.weighing!.freshness.toUpperCase()}` : "";
          const counts = rel.counts ? ` — ${countsBrief(rel.counts)}` : "";
          return `  - ${other}${counts}${note}`;
        };
        const sections: string[] = [];
        if (setMode) {
          const what = `${wanted ? `${[...wanted].join(" or ")} ` : ""}relationship${args.direction === "both" ? "" : ` (${args.direction})`}`;
          const others = starts.slice(1).map(label).join(", ");
          const head =
            args.combine === "intersect"
              ? `${rows.length} concept(s) have a ${what} with all of: ${starts.map(label).join(", ")}.`
              : args.combine === "subtract"
                ? `${rows.length} concept(s) have a ${what} with ${label(starts[0]!)} but with none of: ${others}.`
                : `${rows.length} concept(s) have a ${what} with at least one of: ${starts.map(label).join(", ")}.`;
          sections.push([head, ...items.map(line)].join("\n"));
          sections.push(summary.map((s) => `${s.concept.title}: ${countsBrief(s.relationship_counts)}`).join("\n"));
        } else {
          for (const [n, start] of starts.entries()) {
            const mine = items.flatMap((r, i) => (r.start === start ? [{ r, i }] : []));
            const total = walked[n]!.length;
            const head = goal
              ? found
                ? `${label(start)} and ${label(goal)} are ${found.length} relationship(s) apart${wanted ? `, following only ${[...wanted].join(", ")}` : ""}.`
                : `No chain of typed relationships within ${MAX_CHAIN} hops connects ${label(start)} and ${label(goal)}${wanted ? ` using only ${[...wanted].join(", ")}` : ""}.`
              : args.counts_only
              ? refLine(start, full)
              : total
                ? `${refLine(start, full)}: ${total} relationship(s)${filtered ? " matching the filter" : ""}${hops > 1 ? ` within ${hops} hops` : ""}.`
                : `${refLine(start, full)} has no typed relationships${filtered ? " matching the filter; its counts show what it does have" : ""}.`;
            // One line per relationship, grouped by where it starts, its direction and its type.
            const groups = new Map<string, string[]>();
            for (const { r, i } of mine) {
              const key = `${hops > 1 || goal ? `hop ${r.hop}, ` : ""}${r.from.path === start.path ? "" : `${r.from.title}: `}${r.edge.direction === "outgoing" ? `declares ${r.edge.type} →` : `${r.edge.type} declared to it by ←`}`;
              const list = groups.get(key) ?? [];
              list.push(line(r, i));
              groups.set(key, list);
            }
            const body = [...groups].map(([key, list]) => `${key} (${list.length})\n${list.join("\n")}`).join("\n");
            sections.push([head, goal ? "" : countsLine(summary[n]!.relationship_counts), body].filter(Boolean).join("\n"));
          }
        }
        const notes = [
          full || !rows.length ? "" : 'Related concepts are fresh or timeless unless marked. A title alone names a concept; pass detail: "full" for trust, paths and ids.',
          excluded ? `${excluded} relationship(s) to expired or not-yet-valid concepts left out; pass include_expired: true to see them.` : "",
          p.has_more ? `More: call again with offset ${p.next_offset}.` : "",
        ].filter(Boolean);
        return {
          // With counts_only nothing is listed, so the totals come from the counts: the relationships of the
          // concepts asked about, in the direction and of the types asked for. One between two of them counts for each.
          data: { concepts: summary, combine: args.combine, ...p, ...(tallied ? { total_count: tallied.reduce((n, [, c]) => n + c, 0) } : {}), excluded_expired: excluded, types: tallied ? [...new Set(tallied.map(([t]) => t))].sort() : types, relationships },
          text: [...sections, ...notes].filter(Boolean).join("\n\n"),
        };
      });
      const listedPaths = new Set((out.data.relationships as Array<{ path?: string }>).map((r) => r.path));
      return withLinks(finish(out, args.response_format), [...starts, ...(goal ? [goal] : []), ...window.filter((r) => listedPaths.has(r.edge.concept?.path)).map((r) => r.edge.concept)]);
    },
  );

  registerCatalogTools(server, host, tasks);
  registerExtras(server, host);
  // The write tools and the capture prompt exist only while the vault allows writes; the lists are the same for every client either way.
  if (host.writes().allowed) registerWriteTools(server, host);
  return server;
}
