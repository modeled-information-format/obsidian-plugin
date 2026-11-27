// Tools that look across the vault instead of starting from one concept:
// listing by facts, entities, and the state of the graph and its vector
// store (Phase 1 of docs/PLAN-mcp.md). Few tools with options, not many
// narrow ones: every tool definition is a fixed cost in each session.
//
// tools.ts imports this module and this module imports helpers from
// tools.ts, so nothing here may use those helpers at module load: all use
// is inside registerCatalogTools.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConceptSummary, EdgeView, McpHost, Weighing } from "./host";
import { asOf, cautious, detail, fail, finish, fit, hidden, page, parseAsOf, READ_ONLY, refLine, resolveOrFail, responseFormat, TOOL_NAMES, weighingBrief, weighingSchema, type ToolResult } from "./tools";

const tally = (values: Array<string | undefined>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v ?? "(none)"] = (out[v ?? "(none)"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};
const tallyLine = (t: Record<string, number>, top = 20) => {
  const all = Object.entries(t);
  return all.slice(0, top).map(([k, n]) => `${k} ${n}`).join(", ") + (all.length > top ? `, and ${all.length - top} more` : "") || "none";
};
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "(vault root)");

export function registerCatalogTools(server: McpServer, host: McpHost): void {
  const matching = (edges: EdgeView[], want: { type?: string; direction: "both" | "outgoing" | "incoming" }) =>
    edges.filter((e) => (want.direction === "both" || e.direction === want.direction) && (!want.type || e.type === want.type)).length;

  server.registerTool(
    TOOL_NAMES[3],
    {
      title: "List MIF concepts by their facts",
      description:
        "List this vault's MIF concepts by what is recorded about them, without a search query and without the vector store: " +
        "type, namespace, entity type, folder, words in the title, freshness, trust, and how many typed relationships of a kind they have. " +
        "Use it for questions over the whole vault, such as \"which systems are assessed in two or more assessments\" " +
        "(entity_type \"system\", relationship { type: \"assessed-in\", direction: \"outgoing\", min: 2 }) or \"which concepts are stale\". " +
        "Pass group_by to get counts by a fact instead of a list. Each concept states its freshness and trust where they call for caution; " +
        `cite the concepts you use. Find concepts by meaning with ${TOOL_NAMES[0]}; read one with ${TOOL_NAMES[1]}.`,
      inputSchema: z.object({
        title_contains: z.string().min(1).optional().describe('Only concepts whose title contains this text, ignoring case, e.g. "CON-P-1".'),
        type: z.string().optional().describe('Only this concept type: "semantic", "episodic" or "procedural".'),
        namespace: z.string().optional().describe('Only concepts in this namespace or below it, e.g. "constraints" matches "constraints/security".'),
        entity_type: z.string().optional().describe('Only concepts whose entity type is exactly this, e.g. "constraint".'),
        folder: z.string().optional().describe('Only concepts in this vault folder or below it, e.g. "07-Capability-Model".'),
        freshness: z.array(z.string()).optional().describe('Only these freshness states: "fresh", "ageing", "stale", "expired", "not-yet-valid", "timeless". Naming "expired" or "not-yet-valid" includes them.'),
        trust: z.array(z.string()).optional().describe('Only these trust levels as recorded in provenance, e.g. ["low_confidence"]. Use "(none)" for concepts that record none.'),
        relationship: z
          .object({
            type: z.string().optional().describe("The relationship type to count; omit to count every type."),
            direction: z.enum(["both", "outgoing", "incoming"]).default("both").describe('"outgoing" counts relationships the concept declares, "incoming" those declared to it.'),
            min: z.number().int().min(0).default(1).describe("At least this many."),
            max: z.number().int().min(0).optional().describe("At most this many; 0 with min 0 finds concepts that have none."),
          })
          .optional()
          .describe("Only concepts with this many typed relationships of a kind; each result then gives its count."),
        group_by: z.enum(["type", "entity_type", "namespace", "folder", "freshness", "trust"]).optional().describe("Return counts of the matching concepts by this fact, and no list."),
        sort: z.enum(["title", "path", "relationships"]).default("title").describe('"relationships" puts the concepts with the most matching relationships first.'),
        include_expired: z.boolean().default(false).describe("Also list concepts that have expired or are not yet valid."),
        limit: z.number().int().min(1).default(50).describe("Maximum concepts to return; at most 200, and a larger number is treated as 200."),
        offset: z.number().int().min(0).default(0).describe("Concepts to skip, for the next page."),
        detail,
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        ...page,
        excluded_expired: z.number(),
        groups: z.record(z.string(), z.number()).optional(),
        concepts: z.array(
          z.object({
            path: z.string(),
            title: z.string(),
            id: z.string().optional(),
            type: z.string().optional(),
            namespace: z.string().optional(),
            entity_type: z.string().optional(),
            relationships: z.number().optional(),
            weighing: weighingSchema.optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      const full = args.detail === "full";
      const needle = args.title_contains?.toLowerCase();
      const folder = args.folder?.replace(/^\/+|\/+$/g, "");
      const ns = args.namespace?.replace(/\/+$/, "");
      const freshness = args.freshness ? new Set(args.freshness) : undefined;
      const trust = args.trust ? new Set(args.trust) : undefined;
      const showHidden = args.include_expired || !!(freshness && (freshness.has("expired") || freshness.has("not-yet-valid")));
      let excluded = 0;
      type Row = { c: ConceptSummary; weighing?: Weighing; count?: number };
      const rows: Row[] = [];
      for (const c of host.concepts()) {
        if (needle && !c.title.toLowerCase().includes(needle)) continue;
        if (args.type && c.type !== args.type) continue;
        if (ns && c.namespace !== ns && !c.namespace?.startsWith(`${ns}/`)) continue;
        if (args.entity_type && c.entity_type !== args.entity_type) continue;
        if (folder && c.path !== folder && !c.path.startsWith(`${folder}/`)) continue;
        let count: number | undefined;
        if (args.relationship) {
          count = matching(host.edges(c.path), args.relationship);
          if (count < args.relationship.min || (args.relationship.max !== undefined && count > args.relationship.max)) continue;
        }
        const weighing = host.weigh(c.path, at);
        if (freshness && !(weighing && freshness.has(weighing.freshness))) continue;
        if (trust && !trust.has(weighing?.trust ?? "(none)")) continue;
        if (!showHidden && hidden(weighing)) {
          excluded++;
          continue;
        }
        rows.push({ c, weighing, ...(count === undefined ? {} : { count }) });
      }
      if (args.sort === "relationships") rows.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.c.title.localeCompare(b.c.title));
      else if (args.sort === "title") rows.sort((a, b) => a.c.title.localeCompare(b.c.title));
      const expiredNote = excluded ? `${excluded} expired or not-yet-valid concept(s) left out; pass include_expired: true to see them.` : "";

      if (args.group_by) {
        const by = args.group_by;
        const key = (r: Row) => (by === "folder" ? folderOf(r.c.path) : by === "freshness" ? r.weighing?.freshness : by === "trust" ? r.weighing?.trust : by === "namespace" ? r.c.namespace : r.c[by]);
        const groups = tally(rows.map(key));
        const data = { total_count: rows.length, count: 0, offset: 0, has_more: false, excluded_expired: excluded, groups, concepts: [] };
        const text = [`${rows.length} concept(s) match, by ${by.replace("_", " ")}:`, Object.entries(groups).map(([k, n]) => `  ${k}: ${n}`).join("\n"), expiredNote].filter(Boolean).join("\n");
        return finish({ data, text }, args.response_format);
      }

      const unique = host.uniqueTitles();
      const label = (c: ConceptSummary) => (full ? refLine(c, true) : unique.has(c.title.toLowerCase()) ? c.title : refLine(c, false));
      const window = rows.slice(args.offset, args.offset + Math.min(args.limit, 200));
      const out = fit(window, rows.length, args.offset, false, (items, p) => {
        const concepts = items.map((r) => ({
          path: r.c.path,
          title: r.c.title,
          ...(full && r.c.id ? { id: r.c.id } : {}),
          ...(r.c.type ? { type: r.c.type } : {}),
          ...(r.c.namespace ? { namespace: r.c.namespace } : {}),
          ...(r.c.entity_type ? { entity_type: r.c.entity_type } : {}),
          ...(r.count === undefined ? {} : { relationships: r.count }),
          ...(r.weighing && (full || cautious(r.weighing)) ? { weighing: r.weighing } : {}),
        }));
        const lines = items.map((r) => {
          const note = r.weighing && full ? ` — ${weighingBrief(r.weighing)}` : cautious(r.weighing) ? ` — ${r.weighing!.freshness.toUpperCase()}` : "";
          return `  - ${label(r.c)}${r.count === undefined ? "" : ` — ${r.count}`}${note}`;
        });
        const counted = args.relationship ? ` The number after each is its count of ${args.relationship.type ?? "typed"} relationships${args.relationship.direction === "both" ? "" : ` (${args.relationship.direction})`}.` : "";
        const notes = [
          rows.length && !full ? 'Concepts are fresh or timeless unless marked. A title alone names a concept; pass detail: "full" for trust, paths and ids.' : "",
          expiredNote,
          p.has_more ? `More: call again with offset ${p.next_offset}.` : "",
        ].filter(Boolean);
        const head = rows.length ? `${rows.length} concept(s) match.${counted}` : "No concepts match these filters. Loosen one, or pass group_by to see what values exist.";
        return { data: { ...p, excluded_expired: excluded, concepts }, text: [[head, ...lines].join("\n"), ...notes].join("\n\n") };
      });
      return finish(out, args.response_format);
    },
  );

  server.registerTool(
    TOOL_NAMES[4],
    {
      title: "List MIF entities",
      description:
        "List the entities this vault's concepts refer to: people, organizations, standards and other named things, each with a urn (urn:mif:entity:<type>:<slug>). " +
        "An entity is not a concept: it is a record that concepts point at through their entity references. " +
        "Filter by type or name, or pass referenced_by to see the entities one concept names. Pass include_references to list the concepts that refer to each entity. " +
        `Entity references are evidence that a concept is about something, not that the entity record is complete; cite the concepts. Read a referring concept with ${TOOL_NAMES[1]}.`,
      inputSchema: z.object({
        type: z.string().optional().describe('Only entities of this type, ignoring case, e.g. "policy".'),
        name_contains: z.string().min(1).optional().describe("Only entities whose name or an alias contains this text, ignoring case."),
        referenced_by: z.string().min(1).optional().describe("Only entities this concept refers to (path, id, title or code)."),
        min_references: z.number().int().min(0).default(0).describe("Only entities at least this many concepts refer to."),
        include_references: z.boolean().default(false).describe("List the concepts that refer to each entity, with the role each gives it."),
        group_by_type: z.boolean().default(false).describe("Return counts of entities by type, and no list."),
        limit: z.number().int().min(1).default(50).describe("Maximum entities to return; at most 200."),
        offset: z.number().int().min(0).default(0).describe("Entities to skip, for the next page."),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        ...page,
        groups: z.record(z.string(), z.number()).optional(),
        entities: z.array(
          z.object({
            urn: z.string(),
            name: z.string().optional(),
            type: z.string().optional(),
            bundle: z.string(),
            recorded: z.boolean(),
            reference_count: z.number(),
            references: z.array(z.object({ path: z.string(), title: z.string(), role: z.string().optional() })).optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      let only: string | undefined;
      if (args.referenced_by !== undefined) {
        const c = resolveOrFail(host, args.referenced_by, new Date());
        if ("content" in c) return c;
        only = c.path;
      }
      const type = args.type?.toLowerCase();
      const needle = args.name_contains?.toLowerCase();
      const rows = host.entities().filter((e) => {
        if (type && e.type?.toLowerCase() !== type) return false;
        if (needle && ![e.name ?? "", ...e.aliases].some((n) => n.toLowerCase().includes(needle))) return false;
        if (only && !e.references.some((r) => r.concept.path === only)) return false;
        return e.references.length >= args.min_references;
      });
      if (args.group_by_type) {
        const groups = tally(rows.map((e) => e.type));
        const data = { total_count: rows.length, count: 0, offset: 0, has_more: false, groups, entities: [] };
        return finish({ data, text: [`${rows.length} entit${rows.length === 1 ? "y" : "ies"}, by type:`, Object.entries(groups).map(([k, n]) => `  ${k}: ${n}`).join("\n")].join("\n") }, args.response_format);
      }
      const window = rows.slice(args.offset, args.offset + Math.min(args.limit, 200));
      const out = fit(window, rows.length, args.offset, false, (items, p) => {
        const entities = items.map((e) => ({
          urn: e.urn,
          ...(e.name ? { name: e.name } : {}),
          ...(e.type ? { type: e.type } : {}),
          bundle: e.bundle,
          recorded: e.recorded,
          reference_count: e.references.length,
          ...(args.include_references ? { references: e.references.map((r) => ({ path: r.concept.path, title: r.concept.title, ...(r.role ? { role: r.role } : {}) })) } : {}),
        }));
        const lines = entities.map((e) =>
          [
            `  - ${e.name ?? "(unnamed)"}${e.type ? ` (${e.type})` : ""} — ${e.urn} — ${e.reference_count} reference(s)${e.recorded ? "" : "; no entity record, only referenced"}`,
            ...(e.references ?? []).map((r) => `      ${r.title}${r.role ? ` as ${r.role}` : ""} [${r.path}]`),
          ].join("\n"),
        );
        const head = rows.length ? `${rows.length} entit${rows.length === 1 ? "y" : "ies"} match.` : "No entities match. Pass group_by_type: true to see which types exist.";
        return { data: { ...p, entities }, text: [[head, ...lines].join("\n"), p.has_more ? `More: call again with offset ${p.next_offset}.` : ""].filter(Boolean).join("\n\n") };
      });
      return finish(out, args.response_format);
    },
  );

  server.registerTool(
    TOOL_NAMES[5],
    {
      title: "Get the state of the vault's graph and vector store",
      description:
        "Report on this vault's MIF memory as a whole. report \"graph\": how many concepts, relationships and entities there are, by type, " +
        "how many concepts have no typed relationship, how many relationship targets do not resolve, and how fresh and trusted the concepts are. " +
        "report \"store\": whether semantic search covers the notes: concepts never ingested, changed since they were ingested, or refused. " +
        "report \"gaps\": pairs of similar concepts with no typed relationship, and typed relationships whose two ends are unalike; this one is slow, since it compares every concept of a bundle. " +
        `Use it to judge how far to rely on the vault before answering from it, and as evidence when you report on its health. List concepts behind a number with ${TOOL_NAMES[3]}.`,
      inputSchema: z.object({
        report: z.enum(["graph", "store", "gaps"]).default("graph").describe('"graph" for counts and health, "store" for vector store coverage, "gaps" for missing and doubtful relationships (slow).'),
        bundle: z.string().optional().describe('Only this bundle root; omit for every bundle. "" is the vault root. "gaps" needs one bundle when the vault has several.'),
        limit: z.number().int().min(1).default(25).describe("For gaps and store: maximum pairs or paths to list per group; at most 100."),
        offset: z.number().int().min(0).default(0).describe("For gaps: pairs to skip, for the next page."),
        as_of: asOf,
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        report: z.string(),
        graph: z
          .object({
            bundles: z.array(z.string()),
            concepts: z.number(),
            by_type: z.record(z.string(), z.number()),
            by_entity_type: z.record(z.string(), z.number()),
            relationships: z.number(),
            by_relationship_type: z.record(z.string(), z.number()),
            unresolved_targets: z.number(),
            without_relationships: z.number(),
            freshness: z.record(z.string(), z.number()),
            trust: z.record(z.string(), z.number()),
            entities: z.number(),
          })
          .optional(),
        stores: z
          .array(
            z.object({
              bundle: z.string(),
              stored: z.number().optional(),
              current: z.number(),
              changed_count: z.number(),
              never_count: z.number(),
              orphans: z.number(),
              changed: z.array(z.string()),
              never: z.array(z.string()),
              refused: z.array(z.object({ path: z.string(), reason: z.string() })),
            }),
          )
          .optional(),
        gaps: z
          .object({
            bundle: z.string(),
            compared: z.number(),
            thresholds: z.object({ duplicate: z.number(), similar: z.number(), mislink: z.number() }),
            unlinked_count: z.number(),
            mislink_count: z.number(),
            has_more: z.boolean(),
            next_offset: z.number().optional(),
            unlinked: z.array(z.object({ a: z.string(), b: z.string(), cosine: z.number() })),
            mislinks: z.array(z.object({ a: z.string(), b: z.string(), cosine: z.number() })),
          })
          .optional(),
        problems: z.array(z.string()),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      const at = parseAsOf(args.as_of);
      if (typeof at === "string") return fail(at);
      const bundles = host.vault().bundles;
      if (args.bundle !== undefined && !bundles.includes(args.bundle)) return fail(`No bundle "${args.bundle}". Bundles in this vault: ${bundles.map((b) => `"${b}"`).join(", ")}.`);
      const targets = args.bundle === undefined ? bundles : [args.bundle];
      const cap = Math.min(args.limit, 100);
      const problems: string[] = [];

      if (args.report === "graph") {
        const concepts = host.concepts().filter((c) => targets.includes(c.bundle));
        let relationships = 0;
        let unresolved = 0;
        let alone = 0;
        const types: string[] = [];
        const weighings: Array<Weighing | undefined> = [];
        for (const c of concepts) {
          const edges = host.edges(c.path);
          if (edges.length === 0) alone++;
          for (const e of edges) {
            if (e.direction !== "outgoing") continue;
            relationships++;
            types.push(e.type);
            if (!e.concept) unresolved++;
          }
          weighings.push(host.weigh(c.path, at));
        }
        const graph = {
          bundles: targets,
          concepts: concepts.length,
          by_type: tally(concepts.map((c) => c.type)),
          by_entity_type: tally(concepts.map((c) => c.entity_type)),
          relationships,
          by_relationship_type: tally(types),
          unresolved_targets: unresolved,
          without_relationships: alone,
          freshness: tally(weighings.map((w) => w?.freshness)),
          trust: tally(weighings.map((w) => w?.trust)),
          entities: host.entities().filter((e) => targets.includes(e.bundle)).length,
        };
        const text = [
          `${graph.concepts} concept(s) in ${targets.length} bundle(s), ${graph.relationships} typed relationship(s), ${graph.entities} entit${graph.entities === 1 ? "y" : "ies"}.`,
          `Concept types: ${tallyLine(graph.by_type)}.`,
          `Entity types: ${tallyLine(graph.by_entity_type)}.`,
          `Relationship types: ${tallyLine(graph.by_relationship_type)}.`,
          `${graph.without_relationships} concept(s) have no typed relationship in either direction. ${graph.unresolved_targets} relationship target(s) do not resolve to a concept (an entity, another bundle, or a missing note).`,
          `Freshness: ${tallyLine(graph.freshness)}.`,
          `Trust: ${tallyLine(graph.trust)}.`,
          `List the concepts behind any of these with ${TOOL_NAMES[3]}, for example freshness: ["stale"] or relationship: { min: 0, max: 0 }.`,
        ].join("\n");
        return finish({ data: { report: "graph", graph, problems }, text }, args.response_format);
      }

      if (args.report === "store") {
        const stores = [];
        for (const bundle of targets) {
          const s = await host.store(bundle);
          if ("unavailable" in s) problems.push(targets.length > 1 ? `bundle "${bundle}": ${s.unavailable}` : s.unavailable);
          else stores.push({ bundle, ...(s.stored === undefined ? {} : { stored: s.stored }), current: s.current, changed_count: s.changed.length, never_count: s.never.length, orphans: s.orphans, changed: s.changed.slice(0, cap), never: s.never.slice(0, cap), refused: s.refused.slice(0, cap) });
        }
        if (stores.length === 0) return fail(`The vector store cannot be reported on. ${problems.join(" ")} The graph tools do not need it: use ${TOOL_NAMES[3]} and ${TOOL_NAMES[2]}.`);
        const text = stores
          .map((s) =>
            [
              `Bundle "${s.bundle}": ${s.stored ?? "an unknown number of"} document(s) stored; ${s.current} concept(s) current, ${s.changed_count} changed since ingest, ${s.never_count} never ingested, ${s.refused.length} refused, ${s.orphans} stored document(s) whose note is gone.`,
              s.changed_count + s.never_count > 0 ? "Semantic search does not see the changed or never-ingested concepts as they are now; ask the user to ingest new and changed concepts in Obsidian." : "Semantic search covers every concept of the bundle.",
              s.changed.length ? `Changed since ingest${s.changed_count > s.changed.length ? ` (first ${s.changed.length})` : ""}:\n${s.changed.map((p) => `  - ${p}`).join("\n")}` : "",
              s.never.length ? `Never ingested${s.never_count > s.never.length ? ` (first ${s.never.length})` : ""}:\n${s.never.map((p) => `  - ${p}`).join("\n")}` : "",
              s.refused.length ? `Refused:\n${s.refused.map((r) => `  - ${r.path}: ${r.reason}`).join("\n")}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .concat(problems.length ? [`Not reported: ${problems.join(" ")}`] : [])
          .join("\n\n");
        return finish({ data: { report: "store", stores, problems }, text }, args.response_format);
      }

      if (targets.length !== 1) return fail(`The gap report compares one bundle at a time. Pass bundle; this vault has: ${bundles.map((b) => `"${b}"`).join(", ")}.`);
      const g = await host.gaps(targets[0]!);
      if ("unavailable" in g) return fail(`The gap report is unavailable. ${g.unavailable} ${TOOL_NAMES[0]} with similar_to gives the neighbours of one concept.`);
      const name = (c: { title: string } | undefined) => c?.title ?? "(not in the vault)";
      const pairs = (list: typeof g.unlinked) => list.slice(args.offset, args.offset + cap).map((p) => ({ a: name(p.a), b: name(p.b), cosine: p.cosine }));
      const unlinked = pairs(g.unlinked);
      const mislinks = pairs(g.mislinks);
      const has_more = args.offset + cap < Math.max(g.unlinked.length, g.mislinks.length);
      const thresholds = host.thresholds();
      const gaps = { bundle: g.bundle, compared: g.compared, thresholds, unlinked_count: g.unlinked.length, mislink_count: g.mislinks.length, has_more, ...(has_more ? { next_offset: args.offset + cap } : {}), unlinked, mislinks };
      const text = [
        `Compared ${g.compared} ingested concept(s) of bundle "${g.bundle}".`,
        `${g.unlinked.length} pair(s) are similar (cosine ${thresholds.similar} or more) and have no typed relationship in either direction${unlinked.length ? ":" : "."}`,
        ...unlinked.map((p) => `  - ${p.a} / ${p.b} — cosine ${p.cosine.toFixed(2)}`),
        `${g.mislinks.length} typed relationship(s) join concepts that are unalike (cosine ${thresholds.mislink} or less)${mislinks.length ? ":" : "."}`,
        ...mislinks.map((p) => `  - ${p.a} / ${p.b} — cosine ${p.cosine.toFixed(2)}`),
        "Similarity is a prompt to look, not proof that a relationship is missing or wrong: read both concepts before proposing a change.",
        has_more ? `More: call again with offset ${args.offset + cap}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return finish({ data: { report: "gaps", gaps, problems }, text }, args.response_format);
    },
  );
}
