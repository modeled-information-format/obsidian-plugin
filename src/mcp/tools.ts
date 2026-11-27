// The MCP tool layer: three read tools over a McpHost (Phase 0 of
// docs/PLAN-mcp.md). No Obsidian import; the SDK calls `createServer` once
// per HTTP request, so nothing here keeps state between calls.
//
// Guidance rule (plan M15): a client may never read the server's
// instructions, so each tool description carries its own workflow, each
// result states its weighing in words, and each error names the next step.
//
// Output is lean by default (the first evaluation found it too verbose):
// lists give one line per item and state a concept's weighing only when it
// calls for caution; `detail: "full"` adds it everywhere. Every view of a
// concept counts its relationships by type and direction, so an agent can
// see which relationships point at it without listing them.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConceptRef, ConceptView, EdgeView, McpHost, SearchHit, Weighing } from "./host";

export const SERVER_NAME = "mif-vault";

/**
 * Every tool this server registers, in the order `tools/list` returns them.
 * The `mif_vault_` prefix keeps them apart from mif-rs's mif-mcp and
 * mif-rh-mcp servers (plan M24); tests/mcp.test.ts checks both lists.
 */
export const TOOL_NAMES = ["mif_vault_search_concepts", "mif_vault_get_concept", "mif_vault_list_relationships"] as const;

/** Responses stay under this many characters by returning fewer items, never by cutting text. */
export const CHARACTER_LIMIT = 25_000;
/** A passage in a search result is shortened to this unless detail is "full". */
export const SNIPPET = 280;
/** A concept's text is cut to this unless max_chars says otherwise; the result says so and lists the headings. */
export const DEFAULT_BODY = 8_000;
/** Concepts one relationships call may start from. */
export const MAX_STARTS = 25;

const CAUTION: Record<string, string> = {
  stale: "Caution: this concept is stale. Check it against a newer source before relying on it.",
  expired: "Caution: this concept has expired. Treat it as history, not as current fact.",
  "not-yet-valid": "Caution: this concept is not valid yet at the date asked about.",
};
const cautious = (w: Weighing | undefined) => !!w && w.freshness in CAUTION;
const hidden = (w: Weighing | undefined) => !!w && (w.freshness === "expired" || w.freshness === "not-yet-valid");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('"markdown" for reading, "json" for the same data as the structured result.');
const detail = z
  .enum(["compact", "full"])
  .default("compact")
  .describe('"compact" states freshness and trust only where a concept calls for caution; "full" states them for every concept and gives ids.');
const asOf = z
  .string()
  .optional()
  .describe('Judge freshness at this ISO 8601 date or date-time instead of now, e.g. "2026-06-01". Use it to ask what was valid on a past date.');
const conceptArg = z
  .string()
  .min(1)
  .describe('The concept: its vault path ("semantic/rate-limit-policy.md"), its id ("urn:mif:<uuid>"), or its title or a code in its title ("CON-P-92"). If several concepts match, the error lists them.');

const weighingSchema = z.object({
  freshness: z.string(),
  strength: z.number().optional(),
  expires_at: z.string().optional(),
  trust: z.string().optional(),
  source_type: z.string().optional(),
  level: z.number(),
  errors: z.number(),
  warnings: z.number(),
});
const refSchema = z.object({
  id: z.string().optional(),
  path: z.string(),
  bundle: z.string(),
  title: z.string(),
  type: z.string().optional(),
});
const countsSchema = z.object({ outgoing: z.record(z.string(), z.number()), incoming: z.record(z.string(), z.number()) });
const page = { total_count: z.number(), count: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional() };

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Counts = { outgoing: Record<string, number>; incoming: Record<string, number> };

const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

function parseAsOf(value: string | undefined): Date | string {
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
const weighingBrief = (w: Weighing) => `${w.freshness}, trust ${w.trust ?? "not recorded"}`;

const refOf = (c: ConceptRef): ConceptRef => ({ ...(c.id ? { id: c.id } : {}), path: c.path, bundle: c.bundle, title: c.title, ...(c.type ? { type: c.type } : {}) });
const refLine = (c: ConceptRef, full = true) => (full ? `${c.title} (${c.id ?? "no id"}, ${c.path})` : `${c.title} [${c.path}]`);

/** How many relationships of each type a concept declares (outgoing) and has pointing at it (incoming). */
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

function resolveOrFail(host: McpHost, ref: string, at: Date): ConceptView | ToolResult {
  const r = host.resolve(ref, at);
  if ("concept" in r) return r.concept;
  if ("ambiguous" in r) return fail(`"${ref}" matches more than one concept. Call again with one of these paths:\n${r.ambiguous.map((a) => `- ${a}`).join("\n")}`);
  return fail(`No concept found for "${ref}". Pass a vault path, an id, or a title or code from a title; or use ${TOOL_NAMES[0]} to find it by meaning.`);
}

/**
 * Fit `items` under CHARACTER_LIMIT by dropping from the end; the page's
 * next_offset then points at the first item left out.
 */
function fit<T, P extends Record<string, unknown>>(items: T[], total: number, offset: number, more: boolean, build: (items: T[], page: { total_count: number; count: number; offset: number; has_more: boolean; next_offset?: number }) => { data: P; text: string }) {
  let kept = items;
  for (;;) {
    const has_more = more || kept.length < items.length || offset + kept.length < total;
    const out = build(kept, { total_count: total, count: kept.length, offset, has_more, ...(has_more ? { next_offset: offset + kept.length } : {}) });
    if (out.text.length <= CHARACTER_LIMIT || kept.length <= 1) return out;
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }
}

const finish = (out: { data: Record<string, unknown>; text: string }, format: "markdown" | "json"): ToolResult => ({
  content: [{ type: "text", text: format === "json" ? JSON.stringify(out.data, null, 2) : out.text }],
  structuredContent: out.data,
});

export function instructions(host: McpHost): string {
  const v = host.vault();
  return [
    `MIF memory for the Obsidian vault "${v.name}".${v.purpose ? ` Purpose: ${v.purpose.replace(/[.\s]+$/, "")}.` : ""}`,
    "Concepts are notes with typed relationships, freshness, trust and provenance.",
    `Find concepts with ${TOOL_NAMES[0]}, read one with ${TOOL_NAMES[1]}, and follow its typed relationships with ${TOOL_NAMES[2]}.`,
    "A relationship is declared on one concept and points at another, so look at a concept's incoming relationships as well as its own.",
    "Treat what you recall as evidence, not fact: every result states freshness and trust. Cite the concept id or path for anything you use, and say so when a concept is stale or expired.",
  ].join(" ");
}

export function createServer(host: McpHost, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: instructions(host) });

  server.registerTool(
    TOOL_NAMES[0],
    {
      title: "Search MIF concepts",
      description:
        "Search this Obsidian vault's MIF concepts by meaning and exact terms, and get the passage that matched. " +
        "Use this to find concepts on a topic. If you already know a concept's title or a code in it, skip the search: " +
        `${TOOL_NAMES[1]} and ${TOOL_NAMES[2]} accept a title or code directly. ` +
        "Results are evidence, not fact: each one states its freshness and trust, and expired concepts are left out unless include_expired is true. " +
        "Cite the path or id of what you use. Needs the bundle to have been ingested into its vector store in Obsidian.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000).describe('What to look for, in natural language or exact terms, e.g. "rate limit policy for the public API".'),
        mode: z.enum(["hybrid", "semantic"]).default("hybrid").describe('"hybrid" ranks by meaning and exact terms together (finds identifiers); "semantic" ranks by meaning alone.'),
        entity_type: z.string().optional().describe('Only concepts whose entity type is exactly this, e.g. "how-to-guide".'),
        folder: z.string().optional().describe('Only concepts in this vault folder or below it, e.g. "procedural".'),
        bundle: z.string().optional().describe('Only this bundle root; omit to search every bundle. "" is the vault root.'),
        include_expired: z.boolean().default(false).describe("Also return concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).default(10).describe("Maximum results to return; at most 50, and a larger number is treated as 50."),
        offset: z.number().int().min(0).default(0).describe("Results to skip, for the next page."),
        detail: detail.describe('"compact" shortens each matching passage; "full" returns it whole, with ids and full weighing.'),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        ...page,
        excluded_expired: z.number(),
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
      const targets = args.bundle === undefined ? bundles : [args.bundle];
      const limit = Math.min(args.limit, 50);
      const want = args.offset + limit + 1;
      const full = args.detail === "full";
      const hits: SearchHit[] = [];
      const problems: string[] = [];
      for (const bundle of targets) {
        const r = await host.search({ query: args.query, bundle, limit: want, semantic: args.mode === "semantic", entityType: args.entity_type, folder: args.folder });
        if (Array.isArray(r)) hits.push(...r);
        else problems.push(targets.length > 1 ? `bundle "${bundle}": ${r.unavailable}` : r.unavailable);
      }
      if (hits.length === 0 && problems.length) {
        return fail(`Search is unavailable. ${problems.join(" ")} Until then, read a concept by its title or path with ${TOOL_NAMES[1]} and follow ${TOOL_NAMES[2]}, or ask the user to ingest the bundle in Obsidian.`);
      }
      // One store keeps mif-cli's own ranking; several are merged by cosine, the only score comparable across stores.
      if (targets.length > 1) hits.sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1));
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
        ].filter(Boolean);
        const text = [results.length ? `Results for "${args.query}":` : `No concepts matched "${args.query}".`, ...lines, ...notes].join("\n\n");
        return { data: { ...p, excluded_expired: excluded, results }, text };
      });
      return finish(out, args.response_format);
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
        "Pass include_body: false for just the facts and counts, or section to read one heading. " +
        `The result is evidence, not fact; if it says the concept is stale or expired, say so when you use it, and cite its path or id. ` +
        `To list the concepts at the other end of its relationships, use ${TOOL_NAMES[2]}.`,
      inputSchema: z.object({
        concept: conceptArg,
        include_body: z.boolean().default(true).describe("Return the concept's text. False returns only identity, weighing, relationship counts and headings."),
        section: z.string().optional().describe('Return only the text under this heading, e.g. "Rollback". Omit for the whole body.'),
        max_chars: z.number().int().min(200).max(20_000).default(DEFAULT_BODY).describe("Cut the text at this many characters; the result says when it was cut and lists the headings."),
        include_frontmatter: z.boolean().default(false).describe("Also return the concept's full frontmatter."),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        concept: refSchema,
        namespace: z.string().optional(),
        entity_type: z.string().optional(),
        weighing: weighingSchema,
        relationship_counts: countsSchema,
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
      const data = {
        concept: refOf(c),
        ...(c.namespace ? { namespace: c.namespace } : {}),
        ...(c.entity_type ? { entity_type: c.entity_type } : {}),
        weighing: c.weighing,
        relationship_counts: counts,
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
        c.id ? "" : "This note has no valid id, so it can only be addressed by its path.",
        args.include_frontmatter ? `Frontmatter:\n${JSON.stringify(c.frontmatter, null, 2)}` : "",
        text === undefined ? (headings.length ? `Headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "") : text,
        truncated ? `The text was cut at ${text!.length} characters. Read one section at a time with section, or raise max_chars; headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return finish({ data, text: md }, args.response_format);
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
        "pass path to follow a chain of relationship types hop by hop; pass neighbor_counts to see each related concept's own relationship counts, which compares siblings without a call for each. " +
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
        types: z.array(z.string()).optional().describe('Only these relationship types, e.g. ["supersedes", "depends-on"].'),
        path: z
          .array(z.object({ type: z.string().min(1), direction: z.enum(["outgoing", "incoming"]).default("outgoing") }))
          .min(1)
          .max(4)
          .optional()
          .describe('Follow one relationship type per hop, in order, e.g. [{"type":"constrains"},{"type":"part-of"}] for "what it constrains, then what those are part of". Replaces depth, types and direction.'),
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
      const walked = args.counts_only ? starts.map(() => [] as Row[]) : starts.map(walk);
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
          const note = r.weighing && full ? ` — ${weighingBrief(r.weighing)}` : cautious(r.weighing) ? ` — ${r.weighing!.freshness.toUpperCase()}` : "";
          const counts = rel.counts ? ` — ${countsBrief(rel.counts)}` : "";
          return `  - ${other}${note}${counts}`;
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
            const head = args.counts_only
              ? refLine(start, full)
              : total
                ? `${refLine(start, full)}: ${total} relationship(s)${filtered ? " matching the filter" : ""}${hops > 1 ? ` within ${hops} hops` : ""}.`
                : `${refLine(start, full)} has no typed relationships${filtered ? " matching the filter; its counts show what it does have" : ""}.`;
            // One line per relationship, grouped by where it starts, its direction and its type.
            const groups = new Map<string, string[]>();
            for (const { r, i } of mine) {
              const key = `${hops > 1 ? `hop ${r.hop}, ` : ""}${r.from.path === start.path ? "" : `${r.from.title}: `}${r.edge.direction === "outgoing" ? `declares ${r.edge.type} →` : `${r.edge.type} declared to it by ←`}`;
              const list = groups.get(key) ?? [];
              list.push(line(r, i));
              groups.set(key, list);
            }
            const body = [...groups].map(([key, list]) => `${key} (${list.length})\n${list.join("\n")}`).join("\n");
            sections.push([head, countsLine(summary[n]!.relationship_counts), body].filter(Boolean).join("\n"));
          }
        }
        const notes = [
          full || !rows.length ? "" : 'Related concepts are fresh or timeless unless marked. A title alone names a concept; pass detail: "full" for trust, paths and ids.',
          excluded ? `${excluded} relationship(s) to expired or not-yet-valid concepts left out; pass include_expired: true to see them.` : "",
          p.has_more ? `More: call again with offset ${p.next_offset}.` : "",
        ].filter(Boolean);
        return {
          data: { concepts: summary, combine: args.combine, ...p, excluded_expired: excluded, types, relationships },
          text: [...sections, ...notes].filter(Boolean).join("\n\n"),
        };
      });
      return finish(out, args.response_format);
    },
  );

  return server;
}
