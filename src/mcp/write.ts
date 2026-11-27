// The write tools (Phase 2 of docs/PLAN-mcp.md): four tools with operations,
// registered only while the vault's "Allow writes" setting is on. The rules
// that protect the vault live with the host (src/mcpWrites.ts); this layer
// resolves what the agent names, asks the user where the plan says to, and
// reports what happened.
//
// Asking the user (plan M12, M19) is done by elicitation when the client
// offers it: the tool returns an input-required result and the client calls
// again with the answer. A client that cannot ask gets an error naming the
// choices, and the argument to call again with once the user has answered
// in the conversation.

import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, inputRequired, inputResponse, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Author, ConceptRef, ConceptView, McpHost, Refused } from "./host";
import { fail, finish, refSchema, resolveOrFail, responseFormat, suggest, TOOL_NAMES, typedInFull, unquote, withLinks, type ToolResult } from "./tools";

/** The write tools, in the order `tools/list` returns them after the read tools. */
export const WRITE_TOOL_NAMES = ["mif_vault_write_concept", "mif_vault_write_relationship", "mif_vault_write_reference", "mif_vault_ingest_concepts", "mif_vault_edit_concept"] as const;
export const WRITE_PROMPT_NAMES = ["mif_vault_capture", "mif_vault_review_stale", "mif_vault_curate_links", "mif_vault_consolidate"] as const;

const conceptArg = (what: string) => z.string().min(1).describe(`${what}: its vault path, its id ("urn:mif:<uuid>"), or its title or a code in its title.`);
const confirmArg = z.boolean().optional().describe("Set true only after the user has agreed to this change in the conversation. Needed when the client cannot ask the user itself; a client that can ask is asked directly.");

// Built on first use: this module and tools.ts import each other, so nothing of tools.ts is touched while the modules load.
const writeOutSchema = () => z.object({
  operation: z.string(),
  /** Vault paths of the notes that were created or changed. */
  changed: z.array(z.string()),
  concept: refSchema.optional(),
  superseded: refSchema.optional(),
  /** Concepts merged into `concept`, each kept with its validity ended. */
  merged: z.array(refSchema).optional(),
  urn: z.string().optional(),
  created: z.boolean().optional(),
  duplicates: z.array(z.object({ path: z.string(), title: z.string(), cosine: z.number() })).optional(),
  warnings: z.array(z.string()),
});

type Returned = ToolResult | ReturnType<typeof inputRequired>;

/** What the client sent about itself with the request. The SDK types it as an open object. */
const envelope = (ctx: ServerContext): Record<string, unknown> => ctx.mcpReq.envelope ?? {};

/** The client as it names itself on the request. Self-reported: recorded for attribution, never used to decide anything. */
export function authorOf(ctx: ServerContext): Author {
  const info = envelope(ctx)[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  const name = typeof info?.name === "string" && info.name.trim() ? info.name.trim().slice(0, 80) : "unknown-client";
  return { agent: name, ...(typeof info?.version === "string" && info.version ? { agent_version: info.version.slice(0, 40) } : {}) };
}

const canAsk = (ctx: ServerContext) => !!(envelope(ctx)[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined)?.elicitation;

/**
 * The user's yes to a change that removes or replaces something. True to go
 * ahead; otherwise what to return: a question for the user, or an error that
 * says to ask them.
 */
function confirmed(ctx: ServerContext, given: boolean | undefined, message: string): true | Returned {
  if (given === true) return true;
  if (!canAsk(ctx)) return fail(`${message} This needs the user's agreement. Ask them; if they agree, call again with confirm: true.`);
  const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  if (view.kind === "elicit") {
    const schema = z.object({ confirm: z.boolean() });
    if (view.action === "accept" && acceptedContent(ctx.mcpReq.inputResponses, "confirm", schema)?.confirm === true) return true;
    return fail("The user did not agree, so nothing was changed.");
  }
  return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: z.object({ confirm: z.boolean().describe("Go ahead with this change") }) }) } });
}

/** One of `options`, chosen by the user: the choice, or what to return to get it. */
function chosen(ctx: ServerContext, key: string, argument: string, given: string | undefined, message: string, options: Array<{ value: string; label: string }>, field = "Your choice"): string | Returned {
  const values = options.map((o) => o.value);
  if (given !== undefined) return values.includes(given) ? given : fail(`${argument} must be one of: ${values.join(", ")}.`);
  const listing = options.map((o) => `  - ${o.value}${o.label === o.value ? "" : `: ${o.label}`}`).join("\n");
  if (!canAsk(ctx)) return fail(`${message}\n${listing}\nAsk the user which, then call again with ${argument} set to their choice.`);
  const view = inputResponse(ctx.mcpReq.inputResponses, key);
  if (view.kind === "elicit") {
    const picked = view.action === "accept" ? acceptedContent(ctx.mcpReq.inputResponses, key, z.object({ choice: z.string() }))?.choice : undefined;
    return picked !== undefined && values.includes(picked) ? picked : fail("The user did not choose, so nothing was changed.");
  }
  // The form lists the options itself. They are spelt out in the question only where an option needs
  // explaining; a plain list there would show every option twice (seen in Claude Code's form).
  const explained = options.some((o) => o.label !== o.value);
  return inputRequired({
    inputRequests: { [key]: inputRequired.elicit({ message: explained ? `${message}\n${listing}` : message, requestedSchema: z.object({ choice: z.enum(values as [string, ...string[]]).meta({ title: field }).describe(field) }) }) },
  });
}

const isReturned = (v: unknown): v is Returned => typeof v === "object" && v !== null;
const done = (operation: string, data: Record<string, unknown>, lines: string[], format: "markdown" | "json", links: Array<ConceptRef | undefined> = []): ToolResult =>
  withLinks(finish({ data: { operation, changed: [], warnings: [], ...data }, text: lines.filter(Boolean).join("\n") }, format), links);

export function registerWriteTools(server: McpServer, host: McpHost): void {
  const vocab = host.vocabulary();
  const [writeConcept, writeRelationship, writeReference, ingest, editConcept] = WRITE_TOOL_NAMES;
  const refOf = (c: ConceptView): ConceptRef => ({ path: c.path, bundle: c.bundle, title: c.title, ...(c.id ? { id: c.id } : {}), ...(c.type ? { type: c.type } : {}) });
  const writeOut = writeOutSchema();
  const resolve = (ref: string): ConceptView | ToolResult => resolveOrFail(host, ref, new Date());
  const refused = (r: Refused): ToolResult => fail(r.refused);
  const bundleOr = (given: string | undefined): string | ToolResult => {
    const bundles = host.vault().bundles;
    if (given !== undefined) return bundles.includes(given) ? given : fail(`No bundle "${given}". Bundles in this vault: ${bundles.map((b) => `"${b}"`).join(", ")}.`);
    return bundles.length === 1 ? bundles[0]! : fail(`This vault has several bundles; say which with bundle: ${bundles.map((b) => `"${b}"`).join(", ")}.`);
  };

  server.registerTool(
    writeConcept,
    {
      title: "Write a MIF concept",
      description:
        "Add to this vault's memory: operation \"create\" writes a new concept; \"supersede\" writes one that replaces an existing concept, " +
        "which stays in the vault with its validity ended, so history is kept, and whose relationships the new concept takes over. Supersede when what the vault holds is no longer right; to correct or extend a concept's text, use " + editConcept + ". " +
        "Give the whole text as markdown in body, and declare the concept's relationships, citations and entity references in the same call so it does not arrive unlinked. " +
        "Before creating, the vault is checked for a near-duplicate; if one is found the user is asked whether to keep both, merge into it, supersede it, or stop. " +
        "What you write is saved as agent-written and unverified (freshness and trust are stated to whoever recalls it) until the user reviews it in Obsidian, and your client's name is recorded. " +
        `Find related concepts first with ${TOOL_NAMES[0]} or ${TOOL_NAMES[3]}.`,
      inputSchema: z.object({
        operation: z.enum(["create", "supersede"]).describe('"create" for something new; "supersede" to replace an existing concept with a new one.'),
        title: z.string().min(1).max(200).describe("The concept's title."),
        body: z.string().max(50_000).describe("The concept's text, as markdown. Write it complete; it becomes the note."),
        supersedes: conceptArg("For supersede, the concept being replaced").optional(),
        type: z.enum(["semantic", "episodic", "procedural"]).optional().describe("semantic for facts and decisions, episodic for events, procedural for how-tos. Required for create; a superseding concept keeps the old one's unless given."),
        namespace: z.string().optional().describe("The concept's namespace. The examples are namespaces this vault uses.").meta(suggest(vocab.namespaces)),
        folder: z.string().optional().describe("The folder to save it in, relative to its bundle. Default: a folder named for the type, or beside the concept it supersedes. The examples are this vault's top folders.").meta(suggest(vocab.folders)),
        bundle: z.string().optional().describe('The bundle it belongs to, when the vault has several. "" is the vault root.').meta(suggest(vocab.bundles)),
        summary: z.string().max(500).optional().describe("One or two sentences saying what the concept holds."),
        tags: z.array(z.string()).optional(),
        entity_type: z.string().optional().describe("The concept's entity type. The examples are the entity types this vault uses.").meta(suggest(vocab.entity_types)),
        relationships: z
          .array(
            z.object({
              type: z.string().min(1).describe("The relationship type. The examples are the types this vault uses.").meta(suggest(vocab.relationship_types)),
              target: conceptArg("The concept it points at"),
              strength: z.number().min(0).max(1).optional(),
            }),
          )
          .optional()
          .describe("Typed relationships this concept declares to existing concepts."),
        citations: z
          .array(z.object({ title: z.string().min(1), url: z.string().min(1).describe("Where the source can be found. MIF requires it."), type: z.string().optional().describe("The kind of source: article, book, paper, website, documentation, repository, video, podcast, specification, dataset, tool, or other (the default)."), role: z.string().optional().describe("How the source is used: source (the default), supports, refutes, background, methodology, contradicts, extends, derived, example, or review."), accessed: z.string().optional().describe("The date the source was read, as YYYY-MM-DD in UTC; today's UTC date when omitted. MIF allows a date here, not a time.") }))
          .optional()
          .describe("Where the concept's claims come from."),
        entities: z.array(z.object({ urn: z.string().regex(/^urn:mif:entity:[a-z0-9-]+:[a-z0-9-]+$/), name: z.string().optional(), role: z.string().optional() })).optional().describe(`Entities the concept refers to, by urn. Find them with ${TOOL_NAMES[4]}.`),
        valid_until: z.string().optional().describe("ISO date-time after which the concept is no longer valid, when that is known."),
        on_duplicate: z.enum(["create", "merge", "supersede", "cancel"]).optional().describe('What to do if a near-duplicate exists: "create" keeps both, "merge" writes nothing and tells you how to combine your text into the closest one, "supersede" replaces the closest one, "cancel" writes nothing. Set it only with the user\'s answer; a client that can ask the user is asked directly.'),
        confirm: confirmArg,
        response_format: responseFormat,
      }),
      outputSchema: writeOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx): Promise<Returned> => {
      let old: ConceptView | undefined;
      if (args.operation === "supersede") {
        if (!args.supersedes) return fail('operation "supersede" needs supersedes: the concept being replaced.');
        const o = resolve(args.supersedes);
        if ("content" in o) return o;
        old = o;
      } else if (!args.type) {
        return fail('operation "create" needs type: "semantic", "episodic" or "procedural".');
      }
      const bundle = old ? old.bundle : bundleOr(args.bundle);
      if (typeof bundle !== "string") return bundle;
      const relationships = [];
      for (const r of args.relationships ?? []) {
        const target = resolve(r.target);
        if ("content" in target) return target;
        relationships.push({ type: r.type, target: target.path, ...(r.strength === undefined ? {} : { strength: r.strength }) });
      }
      const warnings: string[] = [];
      let duplicates: Array<{ path: string; title: string; cosine: number }> = [];
      if (!old && args.on_duplicate !== "create") {
        const found = await host.search({ query: [args.title, args.summary].filter(Boolean).join(". "), bundle, limit: 5, semantic: true });
        if (Array.isArray(found)) {
          const floor = host.thresholds().duplicate;
          duplicates = found.flatMap((h) => (h.concept && (h.cosine ?? 0) >= floor ? [{ path: h.concept.path, title: h.concept.title, cosine: h.cosine! }] : []));
        } else {
          warnings.push(`The duplicate check was not run: ${found.unavailable}`);
        }
        if (duplicates.length) {
          const choice = chosen(ctx, "duplicate", "on_duplicate", args.on_duplicate, `The vault already holds something close to "${args.title}": ${duplicates.map((d) => `${d.title} (cosine ${d.cosine.toFixed(2)})`).join("; ")}. What should be done?`, [
            { value: "create", label: "keep both: write the new concept as well" },
            { value: "merge", label: `merge: combine the new text into ${duplicates[0]!.title}` },
            { value: "supersede", label: `replace ${duplicates[0]!.title} with the new concept` },
            { value: "cancel", label: "write nothing" },
          ]);
          if (isReturned(choice)) return choice;
          if (choice === "cancel") return done("cancelled", { duplicates, warnings }, [`Nothing was written: the vault already holds ${duplicates[0]!.title}.`], args.response_format);
          if (choice === "merge") {
            const into = resolve(duplicates[0]!.path);
            if ("content" in into) return into;
            return done(
              "merge_needed",
              { concept: refOf(into), duplicates, warnings },
              [
                `Nothing was written yet. To merge into ${into.title} [${into.path}]: read it with ${TOOL_NAMES[1]} (include_body: true), write one text that combines it with yours,`,
                `then call ${editConcept} with operation "edit", concept "${into.path}" and that text as body. Add your relationships, citations and entity references with ${writeRelationship} and ${writeReference}.`,
              ],
              args.response_format,
              [refOf(into)],
            );
          }
          if (choice === "supersede") {
            const o = resolve(duplicates[0]!.path);
            if ("content" in o) return o;
            old = o;
          }
        }
      }
      if (old) {
        // The user chose "supersede" when asked about the duplicate: that is their agreement.
        const agreed = args.operation === "create" ? true : confirmed(ctx, args.confirm, `Replace "${old.title}" with a new concept "${args.title}"? "${old.title}" stays in the vault with its validity ended now.`);
        if (agreed !== true) return agreed;
      }
      const full = host.admit();
      if (full) return refused(full);
      const author = authorOf(ctx);
      const today = new Date().toISOString().slice(0, 10);
      const r = await host.createConcept(
        {
          title: args.title,
          body: args.body,
          ...(args.type ? { type: args.type } : {}),
          ...(args.namespace ? { namespace: args.namespace } : {}),
          ...(args.folder ? { folder: args.folder } : {}),
          bundle,
          ...(args.summary ? { summary: args.summary } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.entity_type ? { entity_type: args.entity_type } : {}),
          relationships,
          citations: (args.citations ?? []).map((c) => ({ citationType: c.type ?? "other", citationRole: c.role ?? "source", title: c.title, url: c.url, accessed: c.accessed ?? today })),
          entities: args.entities ?? [],
          ...(args.valid_until ? { valid_until: args.valid_until } : {}),
          ...(old ? { supersedes: old.path } : {}),
        },
        author,
      );
      if ("refused" in r) return refused(r);
      return done(
        old ? "supersede" : "create",
        { concept: r.concept, changed: old ? [r.concept.path, old.path] : [r.concept.path], ...(old ? { superseded: refOf(old) } : {}), ...(duplicates.length ? { duplicates } : {}), warnings },
        [
          old ? `Created ${r.concept.title} [${r.concept.path}], which supersedes ${old.title} [${old.path}]. ${old.title} is kept, with its validity ended now.` : `Created ${r.concept.title} [${r.concept.path}].`,
          `It is saved as written by ${author.agent} and unverified, and waits in the user's review queue in Obsidian. Until they review it, recall states it as trust: uncertain.`,
          r.carried ? `It took over ${r.carried} relationship(s) that ${old?.title ?? "the old concept"} declared${relationships.length ? `, and declares the ${relationships.length} you gave` : ""}. Relationships that other concepts declare to the old one still point at it.` : relationships.length ? `It declares ${relationships.length} relationship(s).` : `It declares no relationships; add some with ${writeRelationship} so it can be found from related concepts.`,
          ...warnings,
        ],
        args.response_format,
        [r.concept, old],
      );
    },
  );

  server.registerTool(
    writeRelationship,
    {
      title: "Write a typed relationship",
      description:
        "Change the typed relationships between concepts: operation \"add\" declares one from a concept to another, \"update\" changes its type or strength, \"remove\" deletes it. " +
        "A relationship is declared on the concept named in from and points at target; it is written into that concept's frontmatter and its mirrored Relationships section, never into its prose. " +
        "Use it to turn what you found into structure: for example, link two concepts the gap report shows as similar but unlinked, after reading both. " +
        `If you leave out type when adding, the user is asked to choose one. Update and remove need the user's agreement. See what a concept already declares with ${TOOL_NAMES[2]}; treat a relationship as a claim that someone may rely on as evidence.`,
      inputSchema: z.object({
        operation: z.enum(["add", "update", "remove"]),
        from: conceptArg("The concept that declares the relationship"),
        target: conceptArg("The concept it points at"),
        type: z.string().min(1).optional().describe("The relationship type. For update and remove, the type the relationship has now. The examples are the types this vault uses.").meta(suggest(vocab.relationship_types)),
        new_type: z.string().min(1).optional().describe("For update: the type to change it to.").meta(suggest(vocab.relationship_types)),
        strength: z.number().min(0).max(1).optional().describe("How strong the relationship is, 0 to 1. For update: the new strength."),
        confirm: confirmArg,
        response_format: responseFormat,
      }),
      outputSchema: writeOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx): Promise<Returned> => {
      const from = resolve(args.from);
      if ("content" in from) return from;
      const target = resolve(args.target);
      if ("content" in target) return target;
      if (from.path === target.path) return fail("A concept cannot declare a relationship to itself.");
      const author = authorOf(ctx);
      if (args.operation === "add") {
        const type = chosen(ctx, "type", "type", args.type && args.type.trim() ? args.type : undefined, `Which relationship does "${from.title}" have to "${target.title}"?`, vocab.relationship_types.map((t) => ({ value: t, label: t })), "Relationship type");
        // A type this vault has not used before is allowed when the agent names it; only the choice among known types is offered to the user.
        const picked = args.type ?? type;
        if (isReturned(picked)) return picked;
        const full = host.admit();
        if (full) return refused(full);
        const r = await host.addRelationship(from.path, { type: picked, target: target.path, ...(args.strength === undefined ? {} : { strength: args.strength }) }, author);
        if ("refused" in r) return refused(r);
        const known = vocab.relationship_types.includes(picked);
        return done("add", { concept: r.concept, changed: [from.path], warnings: known ? [] : [`"${picked}" is a relationship type this vault had not used before.`] }, [`${from.title} now declares ${picked} → ${target.title}.`, known ? "" : `"${picked}" is a relationship type this vault had not used before.`], args.response_format, [r.concept, target]);
      }
      if (!args.type) return fail(`operation "${args.operation}" needs type: the type the relationship has now. List what ${from.title} declares with ${TOOL_NAMES[2]}.`);
      if (args.operation === "update" && args.new_type === undefined && args.strength === undefined) return fail('operation "update" needs new_type, strength, or both.');
      const message = args.operation === "remove" ? `Remove the ${args.type} relationship from "${from.title}" to "${target.title}"?` : `Change the ${args.type} relationship from "${from.title}" to "${target.title}"${args.new_type ? ` to ${args.new_type}` : ""}${args.strength === undefined ? "" : `, strength ${args.strength}`}?`;
      const agreed = confirmed(ctx, args.confirm, message);
      if (agreed !== true) return agreed;
      const full = host.admit();
      if (full) return refused(full);
      const match = { type: args.type, target: target.path };
      const r = args.operation === "remove" ? await host.removeRelationship(from.path, match, author) : await host.updateRelationship(from.path, match, { ...(args.new_type ? { type: args.new_type } : {}), ...(args.strength === undefined ? {} : { strength: args.strength }) }, author);
      if ("refused" in r) return refused(r);
      const text = args.operation === "remove" ? `${from.title} no longer declares ${args.type} → ${target.title}.` : `${from.title} now declares ${args.new_type ?? args.type} → ${target.title}${args.strength === undefined ? "" : ` with strength ${args.strength}`}.`;
      return done(args.operation, { concept: r.concept, changed: [from.path] }, [text], args.response_format, [r.concept, target]);
    },
  );

  server.registerTool(
    writeReference,
    {
      title: "Write a citation or an entity reference",
      description:
        "Record where a concept's claims come from and what it is about: operation \"add_citation\" adds a source to a concept; " +
        "\"create_entity\" records a named thing (a person, an organization, a technology) that concepts can refer to, as one of the vault's entity types; \"add_entity_reference\" says a concept refers to an entity. " +
        "These are written into the concept's frontmatter and its mirrored Citations section, never into its prose. " +
        `Name an entity by urn, or by name: if several entities have that name the user is asked which. Find entities with ${TOOL_NAMES[4]}. A citation is evidence for a concept, so cite what you actually read.`,
      inputSchema: z.object({
        operation: z.enum(["add_citation", "create_entity", "add_entity_reference"]),
        concept: conceptArg("For add_citation and add_entity_reference, the concept to change").optional(),
        citation: z
          .object({ title: z.string().min(1), url: z.string().min(1).describe("Where the source can be found. MIF requires it."), type: z.string().optional().describe("The kind of source: article, book, paper, website, documentation, repository, video, podcast, specification, dataset, tool, or other (the default)."), role: z.string().optional().describe("How the source is used: source (the default), supports, refutes, background, methodology, contradicts, extends, derived, example, or review."), accessed: z.string().optional().describe("The date the source was read, as YYYY-MM-DD in UTC; today's UTC date when omitted. MIF allows a date here, not a time.") })
          .optional(),
        entity: z
          .object({
            urn: z.string().regex(/^urn:mif:entity:[a-z0-9-]+:[a-z0-9-]+$/).optional().describe("The entity's urn, for add_entity_reference."),
            name: z.string().min(1).optional().describe("The entity's name: required for create_entity; for add_entity_reference, used to find the entity when no urn is given."),
            type: z.string().min(1).optional().describe(`The entity's type, for create_entity: one of the vault's entity types, which ${TOOL_NAMES[6]} lists. The examples are those types.`).meta(suggest(host.entityTypes().map((t) => t.name))),
            role: z.string().optional().describe("The part the entity plays in the concept, for add_entity_reference."),
          })
          .optional(),
        bundle: z.string().optional().describe('For create_entity, the bundle to record it in, when the vault has several. "" is the vault root.').meta(suggest(vocab.bundles)),
        response_format: responseFormat,
      }),
      outputSchema: writeOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx): Promise<Returned> => {
      const author = authorOf(ctx);
      if (args.operation === "create_entity") {
        if (!args.entity?.name || !args.entity.type) return fail('operation "create_entity" needs entity.name and entity.type.');
        const bundle = bundleOr(args.bundle);
        if (typeof bundle !== "string") return bundle;
        const full = host.admit();
        if (full) return refused(full);
        const r = await host.createEntity(bundle, { type: args.entity.type, name: args.entity.name }, author);
        if ("refused" in r) return fail(`${r.refused} ${TOOL_NAMES[6]} lists them with what each means.`);
        return done("create_entity", { urn: r.urn, created: r.created }, [r.created ? `Recorded the entity ${args.entity.name} as ${r.urn}.` : `${r.urn} already exists; nothing was changed.`, `Refer to it from a concept with ${writeReference}, operation "add_entity_reference".`], args.response_format);
      }
      if (!args.concept) return fail(`operation "${args.operation}" needs concept: the concept to change.`);
      const concept = resolve(args.concept);
      if ("content" in concept) return concept;
      if (args.operation === "add_citation") {
        if (!args.citation) return fail('operation "add_citation" needs citation, with at least a title.');
        const full = host.admit();
        if (full) return refused(full);
        const c = args.citation;
        const r = await host.addCitation(concept.path, { citationType: c.type ?? "other", citationRole: c.role ?? "source", title: c.title, url: c.url, accessed: c.accessed ?? new Date().toISOString().slice(0, 10) }, author);
        if ("refused" in r) return refused(r);
        return done("add_citation", { concept: r.concept, changed: [concept.path] }, [`${concept.title} now cites "${c.title}".`], args.response_format, [r.concept]);
      }
      let urn = args.entity?.urn;
      let name = args.entity?.name;
      if (!urn) {
        if (!name) return fail('operation "add_entity_reference" needs entity.urn, or entity.name to find the entity by.');
        const want = name.toLowerCase();
        const all = host.entities();
        const exact = all.filter((e) => [e.name ?? "", ...e.aliases].some((n) => n.toLowerCase() === want));
        const found = exact.length ? exact : all.filter((e) => (e.name ?? "").toLowerCase().includes(want));
        if (found.length === 0) return fail(`No entity named "${name}" in this vault. Record it first with ${writeReference}, operation "create_entity", or list entities with ${TOOL_NAMES[4]}.`);
        if (found.length === 1) {
          urn = found[0]!.urn;
        } else {
          const choice = chosen(ctx, "entity", "entity.urn", undefined, `Several entities are named "${name}". Which does "${concept.title}" refer to?`, found.slice(0, 12).map((e) => ({ value: e.urn, label: `${e.name ?? ""}${e.type ? ` (${e.type})` : ""}` })));
          if (isReturned(choice)) return choice;
          urn = choice;
        }
        name = all.find((e) => e.urn === urn)?.name ?? name;
      }
      const full = host.admit();
      if (full) return refused(full);
      const r = await host.addEntityReference(concept.path, { urn, ...(name ? { name } : {}), ...(args.entity?.role ? { role: args.entity.role } : {}) }, author);
      if ("refused" in r) return refused(r);
      return done("add_entity_reference", { concept: r.concept, urn, changed: [concept.path] }, [`${concept.title} now refers to ${name ?? urn} (${urn}).`], args.response_format, [r.concept]);
    },
  );

  server.registerTool(
    ingest,
    {
      title: "Ingest concepts into the vector store",
      description:
        "Bring a bundle's vector store up to date, so semantic search sees concepts that are new or have changed. It embeds only what is new or changed, changes the store and never a note, " +
        "and may download the embedding model the first time it runs on a machine. " +
        `Run it after writing concepts if you need to search for them straight away; ${TOOL_NAMES[5]} with report "store" says what is out of date. Search results are evidence only as current as the last ingest.`,
      inputSchema: z.object({
        bundle: z.string().optional().describe('The bundle to ingest; omit when the vault has one. "" is the vault root.').meta(suggest(vocab.bundles)),
        response_format: responseFormat,
      }),
      outputSchema: z.object({ bundle: z.string(), stored: z.number(), unchanged: z.number(), failed: z.array(z.object({ path: z.string(), reason: z.string() })) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, ctx): Promise<Returned> => {
      const bundle = bundleOr(args.bundle);
      if (typeof bundle !== "string") return bundle;
      const full = host.admit();
      if (full) return refused(full);
      const token = ctx.mcpReq._meta?.progressToken;
      const progress = token === undefined ? undefined : (n: number, total: number) => void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: n, total, message: `Ingested ${n} of ${total} concepts` } }).catch(() => undefined);
      const r = await host.ingest(bundle, authorOf(ctx), progress);
      if ("unavailable" in r) return fail(`Ingest is unavailable. ${r.unavailable}`);
      const text = [
        `Bundle "${r.bundle}": ${r.stored} concept(s) embedded, ${r.unchanged} already current, ${r.failed.length} refused.`,
        ...r.failed.map((f) => `  - ${f.path}: ${f.reason}`),
        r.failed.length ? "A refused concept is not searchable until its problem is fixed in Obsidian." : "",
      ]
        .filter(Boolean)
        .join("\n");
      return finish({ data: { bundle: r.bundle, stored: r.stored, unchanged: r.unchanged, failed: r.failed }, text }, args.response_format);
    },
  );

  server.registerTool(
    editConcept,
    {
      title: "Edit or merge MIF concepts",
      description:
        "Change the text of a concept the vault already holds: operation \"edit\" replaces its whole text (body), or one section (section and text), or its summary or tags; " +
        "\"merge\" combines other concepts into it: it takes the merged text you write as its body, takes over their relationships, citations and entity references, and supersedes each of them, which is kept with its validity ended. " +
        "Edit to correct or extend what a concept says while it stays the same claim; when the claim itself has changed, supersede it with " + writeConcept + ", so the old one stays on record. " +
        "Read the concept first and write the new text whole: what you send replaces what is there. The Relationships and Citations sections are rebuilt from the concept's frontmatter and are not yours to write. " +
        "An edited or merged concept goes back to the user's review queue as unverified (trust: uncertain) under your client's name, whatever trust it had, so say that to anyone relying on it as evidence.",
      inputSchema: z.object({
        operation: z.enum(["edit", "merge"]),
        concept: conceptArg("The concept to edit, or the one that the others are merged into"),
        body: z.string().max(50_000).optional().describe("The concept's whole text as markdown, replacing its current text. Required for merge: one text that combines all the concepts'."),
        section: z.string().min(1).optional().describe("For edit: the heading of one section to replace, leaving the rest of the text alone. A heading the concept lacks is added as a new section. Give the section's new text in text."),
        text: z.string().max(50_000).optional().describe("For edit with section: the section's new text, without its heading."),
        summary: z.string().max(500).optional().describe("For edit: a new one- or two-sentence summary."),
        tags: z.array(z.string()).optional().describe("For edit: the concept's tags, replacing the current ones."),
        merge_from: z.array(conceptArg("A concept to merge in")).min(1).max(5).optional().describe("For merge: the concepts to merge into concept."),
        response_format: responseFormat,
      }),
      outputSchema: writeOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx): Promise<Returned> => {
      const concept = resolve(args.concept);
      if ("content" in concept) return concept;
      const author = authorOf(ctx);
      const review = `It is back in the user's review queue in Obsidian as edited by ${author.agent}; until they review it, recall states it as trust: uncertain.`;
      if (args.operation === "merge") {
        if (!args.merge_from?.length) return fail('operation "merge" needs merge_from: the concepts to merge in.');
        if (args.body === undefined) return fail('operation "merge" needs body: one text that combines the concepts\'. Read each with ' + TOOL_NAMES[1] + " first.");
        const from: string[] = [];
        for (const f of args.merge_from) {
          const c = resolve(f);
          if ("content" in c) return c;
          if (c.path === concept.path) return fail("A concept cannot be merged into itself.");
          from.push(c.path);
        }
        const full = host.admit();
        if (full) return refused(full);
        const r = await host.mergeConcepts(concept.path, from, args.body, author);
        if ("refused" in r) return refused(r);
        return done(
          "merge",
          { concept: r.concept, merged: r.merged, changed: [concept.path, ...r.merged.map((m) => m.path)], warnings: r.warnings },
          [`Merged ${r.merged.map((m) => m.title).join(", ")} into ${r.concept.title} [${r.concept.path}]. Each merged concept is kept, superseded, with its validity ended now.`, review, ...r.warnings],
          args.response_format,
          [r.concept, ...r.merged],
        );
      }
      if (args.merge_from) return fail('merge_from is for operation "merge".');
      if ((args.section === undefined) !== (args.text === undefined)) return fail("section and text go together: the heading of the section, and its new text.");
      if (args.body !== undefined && args.section !== undefined) return fail("Give body to replace the whole text, or section and text to replace one section, not both.");
      if (args.body === undefined && args.section === undefined && args.summary === undefined && args.tags === undefined) return fail('operation "edit" needs body, section and text, summary, or tags.');
      const full = host.admit();
      if (full) return refused(full);
      const r = await host.editConcept(
        concept.path,
        { ...(args.body === undefined ? {} : { body: args.body }), ...(args.section === undefined ? {} : { section: { heading: args.section, text: args.text! } }), ...(args.summary === undefined ? {} : { summary: args.summary }), ...(args.tags === undefined ? {} : { tags: args.tags }) },
        author,
      );
      if ("refused" in r) return refused(r);
      const what = [args.body !== undefined ? "its text" : "", args.section !== undefined ? `its "${args.section}" section` : "", args.summary !== undefined ? "its summary" : "", args.tags !== undefined ? "its tags" : ""].filter(Boolean).join(", ");
      return done("edit", { concept: r.concept, changed: [concept.path] }, [`Edited ${r.concept.title} [${r.concept.path}]: ${what}.`, review], args.response_format, [r.concept]);
    },
  );

  server.registerPrompt(
    WRITE_PROMPT_NAMES[0],
    {
      title: "Capture something into the vault's memory",
      description: "Capture a decision, fact or event from this conversation as a concept in the vault, linked to what it relates to and cited.",
      argsSchema: z.object({ what: z.string().min(1).describe("What to capture, in a sentence or two.") }),
    },
    ({ what }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Capture this into the MIF memory of the vault "${host.vault().name}": ${unquote(what)}`,
              typedInFull("what to capture"),
              "",
              `1. Check what the vault already holds: ${TOOL_NAMES[0]} for the topic, or ${TOOL_NAMES[3]} by title. If it is already there and still right, say so and stop.`,
              `2. Decide what it is: semantic (a fact or decision), episodic (something that happened), or procedural (how to do something). If it corrects or adds to a concept the vault holds, edit that concept with ${editConcept}; if it replaces one, supersede it; do not add a second concept that says the same thing.`,
              `3. Write it with ${writeConcept}. Put the whole text in body, in your own words, complete enough to stand alone. Give a one-sentence summary. Declare its relationships to the concepts you found, and cite the sources you actually used.`,
              `4. If it names people, organizations or standards the vault tracks, add entity references with ${writeReference}.`,
              "5. Tell the user what you wrote and where, and that it waits for their review in Obsidian as agent-written and unverified. Do not describe it as verified.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  // The curation workflows (plan: Memory workflows). Each is a prompt over the tools above; none needs a tool of its own.
  const [search, getConcept, listRelationships, listConcepts, , status] = TOOL_NAMES;
  const say = (lines: string[]) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: lines.join("\n") } }] });
  const closing = "Everything you write, edit or merge goes to the user's review queue in Obsidian as unverified. End by listing what you changed, by title and path, and what you left alone and why.";

  server.registerPrompt(
    WRITE_PROMPT_NAMES[1],
    {
      title: "Review stale and expiring concepts",
      description: "Walk through the vault's stale, ageing and expired concepts with the user: reaffirm each, supersede it, or leave it.",
      argsSchema: z.object({
        namespace: z.string().optional().describe("Only concepts in this namespace."),
        limit: z.string().optional().describe("How many concepts to go through; 10 when omitted."),
      }),
    },
    ({ namespace, limit }) =>
      say([
        `Review the concepts of the vault "${host.vault().name}" that are going out of date${namespace ? `, in the namespace ${namespace}` : ""}.`,
        "",
        `1. Find them: ${listConcepts} with freshness: ["expired", "stale", "ageing"]${namespace ? `, namespace: "${namespace}"` : ""}, include_expired: true, limit: ${Number(limit) > 0 ? Number(limit) : 10}. ${status} gives the totals.`,
        `2. Take them one at a time. Read each with ${getConcept}, and look at what relies on it with ${listRelationships} (direction: "incoming").`,
        "3. For each, tell the user in two or three sentences what it says, how old it is, and what relies on it; then ask what to do. Do not decide for them whether something is still true.",
        `   - Still true as written: say so, and leave the note alone. Renewing its dates is done in Obsidian's freshness panel, not here.`,
        `   - Still true but its text needs correcting or extending: ${editConcept}, operation "edit".`,
        `   - No longer true, or replaced: ${writeConcept}, operation "supersede", with the current statement as the new concept. The old one is kept with its validity ended.`,
        "   - The user does not know: leave it, and say so in your summary.",
        `4. ${closing}`,
      ]),
  );

  server.registerPrompt(
    WRITE_PROMPT_NAMES[2],
    {
      title: "Curate typed relationships",
      description: "Work through the relationship-gap report: add typed relationships between similar concepts that have none, and look again at relationships whose ends are unalike.",
      argsSchema: z.object({
        bundle: z.string().optional().describe("The bundle to work on, when the vault has several."),
        entity_type: z.string().optional().describe("Only gaps among concepts of this entity type."),
      }),
    },
    ({ bundle, entity_type }) =>
      say([
        `Turn similarity into structure in the vault "${host.vault().name}": find concepts that are alike but not linked, and link the ones that should be.`,
        "",
        `1. Get the gap report: ${status} with report: "gaps"${bundle !== undefined ? `, bundle: "${bundle}"` : ""}${entity_type ? `, scope: { entity_type: "${entity_type}" }` : ""}. It needs the vector store; if it says the store is missing or out of date, ${ingest} brings it up to date. It can take a while on a large bundle.`,
        `2. For each unlinked pair, most similar first: read both with ${getConcept}. Similar wording is not a relationship. Decide whether one really bears on the other, and how.`,
        `3. Where it does, add the relationship with ${writeRelationship}, operation "add", from the concept that depends on, derives from or refers to the other. Use a type the vault already uses when one fits; the tool's schema lists them. If no type fits or you are unsure, leave type out and the user is asked.`,
        `4. Where the two say the same thing, do not link them: tell the user, and offer to merge them with ${editConcept}, operation "merge".`,
        "5. Where there is no real relationship, add nothing and move on. Say in your summary which pairs you judged unrelated, so the user need not look again.",
        `6. For each reported mislink (a typed relationship whose ends are unalike): read both ends and tell the user what you find. Changing or removing a relationship needs their agreement; ${writeRelationship} asks for it.`,
        `7. ${closing}`,
      ]),
  );

  server.registerPrompt(
    WRITE_PROMPT_NAMES[3],
    {
      title: "Consolidate episodic concepts",
      description: "Turn several episodic concepts on one subject into one semantic concept that states what they add up to and links back to each.",
      argsSchema: z.object({ topic: z.string().min(1).describe("The subject to consolidate, in a few words.") }),
    },
    ({ topic }) =>
      say([
        `Consolidate what the vault "${host.vault().name}" has recorded about: ${unquote(topic)}`,
        typedInFull("the topic"),
        "",
        `1. Find the events: ${search} for the topic, keeping the episodic concepts among the results, and ${listConcepts} with type: "episodic" and title_contains for a word of the topic. Read each candidate with ${getConcept}. Drop the ones that are not about this subject.`,
        `2. Check what the vault already concludes: among the same search results, and with ${listConcepts} with type: "semantic", look for a semantic concept that already states the conclusion. If there is one, extend it with ${editConcept} instead of writing a second one.`,
        "3. Tell the user which episodic concepts you will draw on, with each one's date and freshness, and what you take them to add up to. An expired or low-trust record weighs less; say where you relied on one. Wait for their agreement before writing.",
        `4. Write one semantic concept with ${writeConcept}, operation "create": the general statement, in your own words, complete enough to stand alone, with a derived-from relationship to each episodic concept it rests on. Cite what they cite.`,
        "5. Leave the episodic concepts as they are. They are the record of what happened; the new concept is what was learned from them.",
        `6. ${closing}`,
      ]),
  );
}
