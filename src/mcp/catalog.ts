// Tools that look across the vault instead of starting from one concept:
// listing by facts, entities, and the state of the graph and its vector
// store (Phase 1 of docs/PLAN-mcp.md). Few tools with options, not many
// narrow ones: every tool definition is a fixed cost in each session.
//
// tools.ts imports this module and this module imports helpers from
// tools.ts, so nothing here may use those helpers at module load: all use
// is inside registerCatalogTools.

import { CLIENT_CAPABILITIES_META_KEY, type McpServer } from "@modelcontextprotocol/server";
import { TASKS_EXTENSION, type TaskStore } from "./tasks";
import * as z from "zod/v4";
import type { ConceptSummary, EdgeView, McpHost, Weighing } from "./host";
import { asOf, cautious, detail, fail, finish, fit, hidden, page, parseAsOf, READ_ONLY, refLine, resolveOrFail, responseFormat, suggest, TOOL_NAMES, unknownValue, weighingLine, weighingSchema, withLinks, type ToolResult } from "./tools";

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

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

export function registerCatalogTools(server: McpServer, host: McpHost, tasks?: TaskStore): void {
  const vocab = host.vocabulary();
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
        type: z.string().optional().describe('Only this concept type: "semantic", "episodic" or "procedural".').meta(suggest(vocab.types)),
        namespace: z.string().optional().describe('Only concepts in this namespace or below it, e.g. "constraints" matches "constraints/security". The examples are namespaces this vault uses.').meta(suggest(vocab.namespaces)),
        entity_type: z.string().optional().describe('Only concepts of this entity type, e.g. "constraint", and of the types the vault\'s ontologies declare as its subtypes. The examples are the entity types this vault uses.').meta(suggest(vocab.entity_types)),
        include_subtypes: z.boolean().default(true).describe("With entity_type: also match its subtypes, at any depth, as the loaded ontologies declare them. False matches the named type only."),
        folder: z.string().optional().describe('Only concepts in this vault folder or below it, e.g. "07-Capability-Model". The examples are this vault\'s top folders.').meta(suggest(vocab.folders)),
        freshness: z.array(z.enum(["fresh", "ageing", "stale", "expired", "not-yet-valid", "timeless"])).optional().describe('Only these freshness states. Naming "expired" or "not-yet-valid" includes them.'),
        trust: z.array(z.string().meta(suggest([...vocab.trust, "(none)"]))).optional().describe('Only these trust levels as recorded in provenance, e.g. ["low_confidence"]. Use "(none)" for concepts that record none. The examples are the levels this vault uses.'),
        relationship: z
          .object({
            type: z.string().optional().describe("The relationship type to count; omit to count every type. The examples are the relationship types this vault uses.").meta(suggest(vocab.relationship_types)),
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
      const ontologyTypes = host.ontologies().flatMap((o) => o.entity_types.map((t) => t.name));
      for (const [what, given, valid] of [
        ["concept type", args.type, vocab.types],
        ["entity type", args.entity_type, [...vocab.entity_types, ...ontologyTypes]],
        ["relationship type", args.relationship?.type, vocab.relationship_types],
      ] as const) {
        const bad = given === undefined ? undefined : unknownValue(what, given, [...new Set(valid)]);
        if (bad) return bad;
      }
      // The named entity type and, unless asked otherwise, every type an ontology declares beneath it.
      const entityTypes = args.entity_type === undefined ? undefined : new Set((args.include_subtypes ? host.subtypes(args.entity_type) : [args.entity_type]).map(norm));
      const needle = args.title_contains?.toLowerCase();
      const folder = args.folder?.replace(/^\/+|\/+$/g, "");
      const ns = args.namespace?.replace(/\/+$/, "");
      const freshness = args.freshness ? new Set<string>(args.freshness) : undefined;
      const trust = args.trust ? new Set(args.trust) : undefined;
      const showHidden = args.include_expired || !!(freshness && (freshness.has("expired") || freshness.has("not-yet-valid")));
      let excluded = 0;
      type Row = { c: ConceptSummary; weighing?: Weighing; count?: number };
      const rows: Row[] = [];
      for (const c of host.concepts()) {
        if (needle && !c.title.toLowerCase().includes(needle)) continue;
        if (args.type && c.type !== args.type) continue;
        if (ns && c.namespace !== ns && !c.namespace?.startsWith(`${ns}/`)) continue;
        if (entityTypes && !(c.entity_type && entityTypes.has(norm(c.entity_type)))) continue;
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
          const note = r.weighing && full ? `\n      ${weighingLine(r.weighing).replace(/\n/g, "\n      ")}` : cautious(r.weighing) ? ` — ${r.weighing!.freshness.toUpperCase()}` : "";
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
      const shown = new Set((out.data.concepts as Array<{ path: string }>).map((c) => c.path));
      return withLinks(finish(out, args.response_format), window.filter((r) => shown.has(r.c.path)).map((r) => r.c));
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
        type: z.string().optional().describe('Only entities of this type, ignoring case, e.g. "policy", and of the types the vault\'s ontologies declare as its subtypes. The examples are the entity types this vault\'s entities have.').meta(suggest([...new Set(host.entities().flatMap((e) => (e.type ? [e.type] : [])))].sort())),
        include_subtypes: z.boolean().default(true).describe("With type: also match its subtypes, at any depth, as the loaded ontologies declare them. False matches the named type only."),
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
      const all = host.entities();
      if (args.type !== undefined) {
        const bad = unknownValue("entity type", args.type, [...new Set([...all.flatMap((e) => (e.type ? [e.type] : [])), ...host.ontologies().flatMap((o) => o.entity_types.map((t) => t.name))])]);
        if (bad && !all.some((e) => e.type && norm(e.type) === norm(args.type!))) return bad;
      }
      const types = args.type === undefined ? undefined : new Set((args.include_subtypes ? host.subtypes(args.type) : [args.type]).map(norm));
      const needle = args.name_contains?.toLowerCase();
      const rows = all.filter((e) => {
        if (types && !(e.type && types.has(norm(e.type)))) return false;
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
      const shown = new Set((out.data.entities as Array<{ urn: string }>).map((e) => e.urn));
      const result = finish(out, args.response_format);
      // Each entity is a resource at its urn; with include_references, so is each concept that refers to it.
      const entityLinks = window.filter((e) => shown.has(e.urn)).map((e) => ({ type: "resource_link" as const, uri: e.urn, name: e.name ?? e.urn, mimeType: "application/json" }));
      return withLinks({ ...result, content: [...result.content, ...entityLinks] }, args.include_references ? window.filter((e) => shown.has(e.urn)).flatMap((e) => e.references.map((r) => r.concept)) : []);
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
        "report \"gaps\": pairs of similar concepts with no typed relationship, and typed relationships whose two ends are unalike; it compares every concept of a bundle, so pass scope to report on one kind of concept (an entity type, a namespace, a folder). It reports progress, and a client that declares the Tasks extension gets it as a task to poll. " +
        `Use it to judge how far to rely on the vault before answering from it, and as evidence when you report on its health. List concepts behind a number with ${TOOL_NAMES[3]}.`,
      inputSchema: z.object({
        report: z.enum(["graph", "store", "gaps"]).default("graph").describe('"graph" for counts and health, "store" for vector store coverage, "gaps" for missing and doubtful relationships (slow).'),
        bundle: z.string().optional().describe('Only this bundle root; omit for every bundle. "" is the vault root. "gaps" needs one bundle when the vault has several.').meta(suggest(vocab.bundles)),
        scope: z
          .object({
            entity_type: z.string().optional().describe("Only concepts of this entity type and, unless include_subtypes is false, its subtypes. The examples are the entity types this vault uses.").meta(suggest(vocab.entity_types)),
            include_subtypes: z.boolean().default(true).describe("With entity_type: also match its subtypes as the loaded ontologies declare them."),
            type: z.string().optional().describe('Only this concept type: "semantic", "episodic" or "procedural".').meta(suggest(vocab.types)),
            namespace: z.string().optional().describe("Only concepts in this namespace or below it. The examples are namespaces this vault uses.").meta(suggest(vocab.namespaces)),
            folder: z.string().optional().describe("Only concepts in this vault folder or below it. The examples are this vault's top folders.").meta(suggest(vocab.folders)),
            match: z.enum(["both", "either"]).default("both").describe('"both" keeps a pair only when both of its concepts are in scope; "either" when at least one is.'),
          })
          .optional()
          .describe('For gaps: which concepts the report is about, e.g. { entity_type: "constraint" } for gaps among constraint records only. Without it every pair in the bundle is reported, which on a large vault is dominated by near-identical notes such as daily notes.'),
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
            ontologies: z.array(z.object({ id: z.string(), version: z.string(), uri: z.string(), address: z.enum(["declared", "catalog", "local"]), address_note: z.string().optional() })),
            duplicate_ids: z.array(z.object({ id: z.string(), paths: z.array(z.string()) })),
            /** Concepts an MCP client wrote or edited that the user has not reviewed since. */
            awaiting_review: z.number(),
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
            unscoped_unlinked_count: z.number(),
            unscoped_mislink_count: z.number(),
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
    async (args, ctx): Promise<ToolResult> => {
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
          ontologies: host
            .ontologies()
            .filter((o) => o.bundles.some((b) => targets.includes(b)))
            .map((o) => ({ id: o.id, version: o.version, uri: o.uri, address: o.address, ...(o.address_note ? { address_note: o.address_note } : {}) })),
          duplicate_ids: host.duplicateIds().filter((d) => d.paths.some((p) => concepts.some((c) => c.path === p))),
          awaiting_review: host.reviewQueue().filter((r) => concepts.some((c) => c.path === r.path)).length,
        };
        const text = [
          `${graph.concepts} concept(s) in ${targets.length} bundle(s), ${graph.relationships} typed relationship(s), ${graph.entities} entit${graph.entities === 1 ? "y" : "ies"}.`,
          `Concept types: ${tallyLine(graph.by_type)}.`,
          `Entity types: ${tallyLine(graph.by_entity_type)}.`,
          `Relationship types: ${tallyLine(graph.by_relationship_type)}.`,
          `${graph.without_relationships} concept(s) have no typed relationship in either direction. ${graph.unresolved_targets} relationship target(s) do not resolve to a concept (an entity, another bundle, or a missing note).`,
          `Freshness: ${tallyLine(graph.freshness)}.`,
          `Trust: ${tallyLine(graph.trust)}.`,
          graph.awaiting_review ? `${graph.awaiting_review} concept(s) were written or edited by an MCP client and are not yet reviewed by the user; they read as trust: uncertain.` : "",
          graph.ontologies.length ? `Ontologies loaded, each readable as a resource at its address:\n${graph.ontologies.map((o) => `  - ${o.id} ${o.version} — ${o.uri}${o.address_note ? ` (${o.address_note})` : ""}`).join("\n")}` : "Ontologies loaded: none.",
          graph.duplicate_ids.length
            ? `${graph.duplicate_ids.length} id(s) are carried by more than one note, so those notes cannot be told apart by id; address them by path:\n${graph.duplicate_ids.map((d) => `  - ${d.id}: ${d.paths.join(", ")}`).join("\n")}`
            : "No id is carried by more than one note.",
          `List the concepts behind any of these with ${TOOL_NAMES[3]}, for example freshness: ["stale"] or relationship: { min: 0, max: 0 }.`,
        ]
          .filter(Boolean)
          .join("\n");
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
      // The comparison is one mif-cli run per concept: report progress to a caller that asked for it.
      const token = ctx.mcpReq._meta?.progressToken;
      const notify =
        token === undefined
          ? undefined
          : (done: number, total: number) => {
              if (done === total || done % 10 === 0) void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message: `Compared ${done} of ${total} concepts` } }).catch(() => undefined);
            };
      const run = async (report?: (done: number, total: number) => void): Promise<ToolResult> => {
      const g = await host.gaps(targets[0]!, report);
      if ("unavailable" in g) return fail(`The gap report is unavailable. ${g.unavailable} ${TOOL_NAMES[0]} with similar_to gives the neighbours of one concept.`);
      const name = (c: { title: string } | undefined) => c?.title ?? "(not in the vault)";
      // The comparison always covers the bundle; the scope chooses which of its pairs to report.
      const scope = args.scope;
      let inScope: ((path: string | undefined) => boolean) | undefined;
      let scopeText = "";
      if (scope && (scope.entity_type || scope.type || scope.namespace || scope.folder)) {
        const ontologyTypes = host.ontologies().flatMap((o) => o.entity_types.map((t) => t.name));
        for (const [what, given, valid] of [
          ["concept type", scope.type, vocab.types],
          ["entity type", scope.entity_type, [...new Set([...vocab.entity_types, ...ontologyTypes])]],
        ] as const) {
          const bad = given === undefined ? undefined : unknownValue(what, given, [...valid]);
          if (bad) return bad;
        }
        const entityTypes = scope.entity_type === undefined ? undefined : new Set((scope.include_subtypes ? host.subtypes(scope.entity_type) : [scope.entity_type]).map(norm));
        const ns = scope.namespace?.replace(/\/+$/, "");
        const folder = scope.folder?.replace(/^\/+|\/+$/g, "");
        const members = new Set(
          host
            .concepts()
            .filter(
              (c) =>
                (!entityTypes || (c.entity_type !== undefined && entityTypes.has(norm(c.entity_type)))) &&
                (!scope.type || c.type === scope.type) &&
                (!ns || c.namespace === ns || !!c.namespace?.startsWith(`${ns}/`)) &&
                (!folder || c.path === folder || c.path.startsWith(`${folder}/`)),
            )
            .map((c) => c.path),
        );
        inScope = (path) => path !== undefined && members.has(path);
        scopeText = ` Scope: ${[scope.entity_type && `entity type ${scope.entity_type}`, scope.type && `type ${scope.type}`, ns && `namespace ${ns}`, folder && `folder ${folder}`].filter(Boolean).join(", ")}; ${members.size} concept(s); a pair is kept when ${scope.match === "both" ? "both of its concepts are" : "either of its concepts is"} in scope.`;
      }
      const keep = (p: (typeof g.unlinked)[number]) => !inScope || (scope!.match === "both" ? inScope(p.a?.path) && inScope(p.b?.path) : inScope(p.a?.path) || inScope(p.b?.path));
      const scoped = { unlinked: g.unlinked.filter(keep), mislinks: g.mislinks.filter(keep) };
      const total = { unlinked: g.unlinked.length, mislinks: g.mislinks.length };
      g.unlinked = scoped.unlinked;
      g.mislinks = scoped.mislinks;
      const pairs = (list: typeof g.unlinked) => list.slice(args.offset, args.offset + cap).map((p) => ({ a: name(p.a), b: name(p.b), cosine: p.cosine }));
      const unlinked = pairs(g.unlinked);
      const mislinks = pairs(g.mislinks);
      const has_more = args.offset + cap < Math.max(g.unlinked.length, g.mislinks.length);
      const thresholds = host.thresholds();
      const gaps = { bundle: g.bundle, compared: g.compared, thresholds, unlinked_count: g.unlinked.length, mislink_count: g.mislinks.length, unscoped_unlinked_count: total.unlinked, unscoped_mislink_count: total.mislinks, has_more, ...(has_more ? { next_offset: args.offset + cap } : {}), unlinked, mislinks };
      const text = [
        `Compared ${g.compared} ingested concept(s) of bundle "${g.bundle}".${scopeText}`,
        inScope ? `In the whole bundle there are ${total.unlinked} unlinked pair(s) and ${total.mislinks} doubtful relationship(s).` : total.unlinked > 200 ? `That is a long list. Pass scope, for example { entity_type: "…" } or { folder: "…" }, to report on one kind of concept.` : "",
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
      };
      // A client that declares the Tasks extension gets a task at once and polls for the report; any other waits on this request.
      const declared = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: Record<string, unknown> } | undefined;
      const task = tasks && declared?.extensions?.[TASKS_EXTENSION] ? tasks.start((say) => run((done, total) => say(`Compared ${done} of ${total} concepts`))) : undefined;
      if (task) return { resultType: "task", ...task } as unknown as ToolResult;
      return run(notify);
    },
  );

  server.registerTool(
    TOOL_NAMES[6],
    {
      title: "List MIF entity types",
      description:
        "List the entity types this vault has: the core types every bundle has (Person, Organization, Technology, Concept, File) and the types its loaded ontologies define, " +
        "each with the ontology that defines it, its base concept type, what it is a subtype of, and how many entity records and concepts of that type the vault holds. " +
        "An entity can be recorded only as one of these types, so read this before recording one. " +
        `A type is a definition, not evidence that the vault holds anything of it; the counts say what it holds. List the entities of a type with ${TOOL_NAMES[4]}, and the concepts with ${TOOL_NAMES[3]}.`,
      inputSchema: z.object({
        bundle: z.string().optional().describe('Only the types of this bundle. "" is the vault root. Omit for every bundle.').meta(suggest(vocab.bundles)),
        name_contains: z.string().min(1).optional().describe("Only types whose name or description contains this text, ignoring case."),
        source: z.string().optional().describe('Only types from this source: "core", or an ontology id.'),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        count: z.number(),
        entity_types: z.array(
          z.object({
            name: z.string(),
            /** The type segment of an entity urn of this type. */
            slug: z.string(),
            source: z.string(),
            base: z.string().optional(),
            description: z.string().optional(),
            subtype_of: z.array(z.string()),
            bundles: z.array(z.string()),
            entities: z.number(),
            concepts: z.number(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async (args): Promise<ToolResult> => {
      if (args.bundle !== undefined && !vocab.bundles.includes(args.bundle)) return fail(`No bundle "${args.bundle}". Bundles in this vault: ${vocab.bundles.map((b) => `"${b}"`).join(", ")}.`);
      const needle = args.name_contains?.toLowerCase();
      const entity_types = host.entityTypes().filter(
        (t) =>
          (args.bundle === undefined || t.bundles.includes(args.bundle)) &&
          (args.source === undefined || t.source.toLowerCase() === args.source.toLowerCase()) &&
          (!needle || t.name.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle)),
      );
      const lines = entity_types.map(
        (t) =>
          `  - ${t.name} (urn segment "${t.slug}") — ${t.source === "core" ? "core" : `ontology ${t.source}`}${t.base ? `, ${t.base}` : ""}${t.subtype_of.length ? `, subtype of ${t.subtype_of.join(", ")}` : ""}` +
          ` — ${t.entities} entit${t.entities === 1 ? "y" : "ies"}, ${t.concepts} concept(s)${t.description ? ` — ${t.description}` : ""}`,
      );
      const head = entity_types.length ? `${entity_types.length} entity type(s).` : "No entity type matches.";
      return finish({ data: { count: entity_types.length, entity_types }, text: [head, ...lines].join("\n") }, args.response_format);
    },
  );
}
