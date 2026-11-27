// The MCP tool layer: three read tools over a McpHost (Phase 0 of
// docs/PLAN-mcp.md). No Obsidian import; the SDK calls `createServer` once
// per HTTP request, so nothing here keeps state between calls.
//
// Guidance rule (plan M15): a client may never read the server's
// instructions, so each tool description carries its own workflow, each
// result states its weighing in words, and each error names the next step.

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

const CAUTION: Record<string, string> = {
  stale: "Caution: this concept is stale. Check it against a newer source before relying on it.",
  expired: "Caution: this concept has expired. Treat it as history, not as current fact.",
  "not-yet-valid": "Caution: this concept is not valid yet at the date asked about.",
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('"markdown" for reading, "json" for the same data as the structured result.');
const asOf = z
  .string()
  .optional()
  .describe('Judge freshness at this ISO 8601 date or date-time instead of now, e.g. "2026-06-01". Use it to ask what was valid on a past date.');
const conceptArg = z
  .string()
  .min(1)
  .describe('The concept: its id ("urn:mif:<uuid>"), or its vault path ("semantic/rate-limit-policy.md"), as returned by the other tools.');

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
const page = { total_count: z.number(), count: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional() };

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

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

const refOf = (c: ConceptRef): ConceptRef => ({ ...(c.id ? { id: c.id } : {}), path: c.path, bundle: c.bundle, title: c.title, ...(c.type ? { type: c.type } : {}) });
const refLine = (c: ConceptRef) => `${c.title} (${c.id ?? "no id"}, ${c.path})`;

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
  if ("ambiguous" in r) return fail(`"${ref}" matches more than one note: ${r.ambiguous.join(", ")}. Two notes share this id; call again with one of these paths.`);
  return fail(`No concept found for "${ref}". Use ${TOOL_NAMES[0]} to find it, then pass the id or path from that result.`);
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
        "Use this first to find concepts on a topic. Results are evidence, not fact: each one states its freshness and trust, " +
        `and expired concepts are left out unless include_expired is true. Cite the id or path of what you use. ` +
        `Read a whole concept with ${TOOL_NAMES[1]}; follow its typed relationships with ${TOOL_NAMES[2]}. ` +
        "Needs the bundle to have been ingested into its vector store in Obsidian.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000).describe('What to look for, in natural language or exact terms, e.g. "rate limit policy for the public API".'),
        mode: z.enum(["hybrid", "semantic"]).default("hybrid").describe('"hybrid" ranks by meaning and exact terms together (finds identifiers); "semantic" ranks by meaning alone.'),
        entity_type: z.string().optional().describe('Only concepts whose entity type is exactly this, e.g. "how-to-guide".'),
        folder: z.string().optional().describe('Only concepts in this vault folder or below it, e.g. "procedural".'),
        bundle: z.string().optional().describe('Only this bundle root; omit to search every bundle. "" is the vault root.'),
        include_expired: z.boolean().default(false).describe("Also return concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return."),
        offset: z.number().int().min(0).default(0).describe("Results to skip, for the next page."),
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
      const want = args.offset + args.limit + 1;
      const hits: SearchHit[] = [];
      const problems: string[] = [];
      for (const bundle of targets) {
        const r = await host.search({ query: args.query, bundle, limit: want, semantic: args.mode === "semantic", entityType: args.entity_type, folder: args.folder });
        if (Array.isArray(r)) hits.push(...r);
        else problems.push(targets.length > 1 ? `bundle "${bundle}": ${r.unavailable}` : r.unavailable);
      }
      if (hits.length === 0 && problems.length) {
        return fail(`Search is unavailable. ${problems.join(" ")} Until then, read a concept you already know with ${TOOL_NAMES[1]} and follow ${TOOL_NAMES[2]}, or ask the user to ingest the bundle in Obsidian.`);
      }
      // One store keeps mif-cli's own ranking; several are merged by cosine, the only score comparable across stores.
      if (targets.length > 1) hits.sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1));
      let excluded = 0;
      const weighed = hits.flatMap((h) => {
        const weighing = h.concept ? host.weigh(h.concept.path, at) : undefined;
        if (!args.include_expired && weighing && (weighing.freshness === "expired" || weighing.freshness === "not-yet-valid")) {
          excluded++;
          return [];
        }
        return [{ ...h, weighing }];
      });
      const window = weighed.slice(args.offset, args.offset + args.limit);
      const more = weighed.length > args.offset + args.limit;
      const out = fit(window, Math.max(weighed.length, args.offset + window.length), args.offset, more, (items, p) => {
        const results = items.map((h) => ({
          id: h.id,
          ...(h.concept ? { concept: refOf(h.concept) } : {}),
          ...(h.title ? { title: h.title } : {}),
          ...(h.cosine === undefined ? {} : { cosine: h.cosine }),
          ...(h.heading ? { heading: h.heading } : {}),
          ...(h.passage ? { passage: h.passage } : {}),
          ...(h.weighing ? { weighing: h.weighing } : {}),
        }));
        const lines = results.map((r, i) =>
          [
            `${p.offset + i + 1}. ${r.concept ? refLine(r.concept) : `${r.title ?? "(not in the vault)"} (${r.id})`}${r.cosine === undefined ? "" : ` — cosine ${r.cosine.toFixed(2)}`}`,
            r.weighing ? `   ${weighingLine(r.weighing).replace(/\n/g, "\n   ")}` : "   Not in the vault any more: the store holds a document whose note is gone.",
            r.passage ? `   ${r.heading ? `Under "${r.heading}": ` : ""}${r.passage.replace(/\s+/g, " ").trim()}` : "",
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
        "Read one MIF concept from this Obsidian vault: its identity, how far it can be relied on (freshness, trust, provenance, conformance), " +
        "its frontmatter, and its text. Pass section to read one heading instead of the whole body. " +
        `The result is evidence, not fact; if it says the concept is stale or expired, say so when you use it, and cite its id. ` +
        `To see what it is related to, use ${TOOL_NAMES[2]}.`,
      inputSchema: z.object({
        concept: conceptArg,
        section: z.string().optional().describe('Return only the text under this heading, e.g. "Rollback". Omit for the whole body.'),
        include_frontmatter: z.boolean().default(false).describe("Also return the concept's full frontmatter."),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        concept: refSchema,
        namespace: z.string().optional(),
        entity_type: z.string().optional(),
        weighing: weighingSchema,
        headings: z.array(z.string()),
        section: z.string().optional(),
        text: z.string(),
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
      let text = c.body.trim();
      if (args.section !== undefined) {
        const s = sectionOf(c.body, args.section);
        if (s === undefined) return fail(`"${c.title}" has no heading "${args.section}". Its headings: ${headings.length ? headings.map((h) => `"${h}"`).join(", ") : "none"}. Omit section to read the whole concept.`);
        text = s;
      }
      // A body over the limit is not cut silently: say so, and point at sections.
      const room = CHARACTER_LIMIT - 2_000 - (args.include_frontmatter ? JSON.stringify(c.frontmatter).length : 0);
      const truncated = text.length > room;
      if (truncated) text = text.slice(0, Math.max(0, room));
      const data = {
        concept: refOf(c),
        ...(c.namespace ? { namespace: c.namespace } : {}),
        ...(c.entity_type ? { entity_type: c.entity_type } : {}),
        weighing: c.weighing,
        headings,
        ...(args.section === undefined ? {} : { section: args.section }),
        text,
        truncated,
        ...(args.include_frontmatter ? { frontmatter: c.frontmatter } : {}),
      };
      const md = [
        `# ${c.title}`,
        `${c.id ?? "no id"} · ${c.path}${c.type ? ` · ${c.type}` : ""}${c.namespace ? ` · ${c.namespace}` : ""}${c.entity_type ? ` · ${c.entity_type}` : ""}`,
        weighingLine(c.weighing),
        c.id ? "" : "This note has no valid id, so it can only be addressed by its path.",
        args.include_frontmatter ? `Frontmatter:\n${JSON.stringify(c.frontmatter, null, 2)}` : "",
        text,
        truncated ? `The text was cut at ${text.length} characters. Read one section at a time with section; headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return finish({ data, text: md }, args.response_format);
    },
  );

  server.registerTool(
    TOOL_NAMES[2],
    {
      title: "List a concept's typed relationships",
      description:
        "List the typed relationships of one MIF concept, outgoing and incoming, up to depth hops away. " +
        "These are the relationships an author declared (for example supersedes, depends-on, relates-to), not similarity. " +
        "Use it to answer questions that span several concepts: follow the relationship types that fit the question. " +
        `Each related concept states its freshness and trust; expired ones are left out unless include_expired is true. ` +
        `Read a related concept with ${TOOL_NAMES[1]}.`,
      inputSchema: z.object({
        concept: conceptArg,
        depth: z.number().int().min(1).max(3).default(1).describe("How many hops to follow. 1 is the concept's own relationships."),
        direction: z.enum(["both", "outgoing", "incoming"]).default("both").describe('"outgoing" for relationships this concept declares, "incoming" for those that point at it.'),
        types: z.array(z.string()).optional().describe('Only these relationship types, e.g. ["supersedes", "depends-on"].'),
        include_expired: z.boolean().default(false).describe("Also follow relationships to concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum relationships to return."),
        offset: z.number().int().min(0).default(0).describe("Relationships to skip, for the next page."),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        concept: refSchema,
        ...page,
        excluded_expired: z.number(),
        types: z.array(z.string()),
        relationships: z.array(
          z.object({
            hop: z.number(),
            from: refSchema,
            type: z.string(),
            direction: z.enum(["outgoing", "incoming"]),
            target: z.string(),
            strength: z.number().optional(),
            concept: refSchema.optional(),
            weighing: weighingSchema.optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      const start = resolveOrFail(host, args.concept, at);
      if ("content" in start) return start;
      const wanted = args.types ? new Set(args.types) : undefined;
      type Row = { hop: number; from: ConceptRef; edge: EdgeView; weighing?: Weighing };
      const rows: Row[] = [];
      const seen = new Set([start.path]);
      const listed = new Set<string>();
      let excluded = 0;
      let frontier: ConceptRef[] = [start];
      for (let hop = 1; hop <= args.depth && frontier.length; hop++) {
        const next: ConceptRef[] = [];
        for (const from of frontier) {
          for (const edge of host.edges(from.path)) {
            if (args.direction !== "both" && edge.direction !== args.direction) continue;
            if (wanted && !wanted.has(edge.type)) continue;
            // An edge between two listed concepts is reached from both ends; list it once.
            const [a, b] = edge.direction === "outgoing" ? [from.path, edge.concept?.path ?? edge.target] : [edge.concept?.path ?? edge.target, from.path];
            const key = `${a}\u0000${edge.type}\u0000${b}`;
            if (listed.has(key)) continue;
            const weighing = edge.concept ? host.weigh(edge.concept.path, at) : undefined;
            if (!args.include_expired && weighing && (weighing.freshness === "expired" || weighing.freshness === "not-yet-valid")) {
              excluded++;
              continue;
            }
            listed.add(key);
            rows.push({ hop, from, edge, weighing });
            if (edge.concept && !seen.has(edge.concept.path)) {
              seen.add(edge.concept.path);
              next.push(edge.concept);
            }
          }
        }
        frontier = next;
      }
      const types = [...new Set(rows.map((r) => r.edge.type))].sort();
      const window = rows.slice(args.offset, args.offset + args.limit);
      const out = fit(window, rows.length, args.offset, false, (items, p) => {
        const relationships = items.map((r) => ({
          hop: r.hop,
          from: refOf(r.from),
          type: r.edge.type,
          direction: r.edge.direction,
          target: r.edge.target,
          ...(r.edge.strength === undefined ? {} : { strength: r.edge.strength }),
          ...(r.edge.concept ? { concept: refOf(r.edge.concept) } : {}),
          ...(r.weighing ? { weighing: r.weighing } : {}),
        }));
        const lines = relationships.map((r) => {
          const other = r.concept ? refLine(r.concept) : `${r.target} (does not resolve to a concept in the bundle)`;
          const arrow = r.direction === "outgoing" ? `${r.from.title} —${r.type}→ ${other}` : `${other} —${r.type}→ ${r.from.title}`;
          return `- hop ${r.hop}: ${arrow}${r.weighing ? `\n  ${weighingLine(r.weighing).replace(/\n/g, "\n  ")}` : ""}`;
        });
        const notes = [
          excluded ? `${excluded} relationship(s) to expired or not-yet-valid concepts left out; pass include_expired: true to see them.` : "",
          p.has_more ? `More relationships: call again with offset ${p.next_offset}.` : "",
        ].filter(Boolean);
        const head = rows.length
          ? `Typed relationships of ${refLine(start)}, ${args.depth} hop(s), ${rows.length} in all:`
          : `${refLine(start)} has no typed relationships${wanted ? " of the types asked for" : ""}. Use ${TOOL_NAMES[0]} to find concepts on the same topic.`;
        return { data: { concept: refOf(start), ...p, excluded_expired: excluded, types, relationships }, text: [head, lines.join("\n"), ...notes].filter(Boolean).join("\n\n") };
      });
      return finish(out, args.response_format);
    },
  );

  return server;
}
