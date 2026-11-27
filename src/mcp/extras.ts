// What the server offers beyond tools (Phase 1 of docs/PLAN-mcp.md):
// concepts and entities as resources at their canonical MIF identifiers,
// and two prompts. Like catalog.ts, this module is imported by tools.ts and
// imports from it, so those imports are used only inside registerExtras.

import { completable, ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { McpHost } from "./host";
import { countEdges, countsLine, TOOL_NAMES, weighingLine } from "./tools";

/** Prompts, in the order `prompts/list` returns them. Same prefix as the tools (plan M24). */
export const PROMPT_NAMES = ["mif_vault_guide", "mif_vault_recall"] as const;

/** `urn:mif:<uuid>` names a concept and `urn:mif:entity:<type>:<slug>` an entity (plan M23). */
export const RESOURCE_TEMPLATE = "urn:mif:{id}";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A note changes whenever its author saves it, and nothing tells the client: keep cached copies short-lived and private. */
const CACHE = { ttlMs: 5_000, cacheScope: "private" as const };

export function guide(host: McpHost): string {
  const v = host.vault();
  const [search, get, relate, list, entities, status] = TOOL_NAMES;
  return [
    `This is the MIF memory of the Obsidian vault "${v.name}".${v.purpose ? ` Its purpose: ${v.purpose.replace(/[.\s]+$/, "")}.` : ""}`,
    "",
    "What is in it. Concepts are notes: each has a type (semantic, episodic or procedural), a title, a namespace, often an entity type, and text. Concepts declare typed relationships to other concepts. Entities are named things that concepts refer to.",
    "",
    "How to find things.",
    `- You know a title or a code in a title: pass it straight to ${get} or ${relate}. No search is needed.`,
    `- You know a topic: ${search}. It needs the vector store; if that is missing it says so.`,
    `- You know facts about what you want (its type, its folder, how many relationships of a kind it has): ${list}.`,
    `- You want named things, such as people or standards: ${entities}.`,
    "",
    "How relationships work. A relationship is declared on one concept and points at another. Outgoing relationships are the ones a concept declares; incoming ones are declared by other concepts and point at it. " +
      `"What is grounded in X" and "what is briefed in X" are X's incoming relationships. Every view of a concept counts its relationships by type and direction, so read the counts before deciding which to list. ` +
      `${relate} can answer in one call what several concepts share (combine), follow a chain of types (path), connect two concepts (path_to), and compare related concepts (neighbor_counts).`,
    "",
    "How far to rely on it. Treat what you recall as evidence, not fact. Each concept states its freshness (fresh, ageing, stale, expired, not yet valid, or timeless) and the trust its author recorded. " +
      "Expired concepts are left out unless you ask for them. Lists mark a concept only where it calls for caution. " +
      `When you use a concept, cite its title or path, and say so if it is stale, expired or low in trust. Use as_of to ask what was valid on a past date. ${status} reports how complete and current the vault is as a whole.`,
    "",
    "This server only reads. It does not write notes or change the vector store.",
  ].join("\n");
}

export function registerExtras(server: McpServer, host: McpHost): void {
  server.registerResource(
    "mif-record",
    // Not enumerable: a vault holds thousands of concepts, and the tools are how to find one. The template says how to address one you have found.
    new ResourceTemplate(RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "MIF concept or entity",
      description: 'A concept at its canonical id, "urn:mif:<uuid>", as markdown with its weighing; or an entity at "urn:mif:entity:<type>:<slug>", as JSON. Ids come from the tools\' results.',
      cacheHint: CACHE,
    },
    (uri) => {
      const href = uri.href;
      const id = href.replace(/^urn:mif:/i, "");
      if (/^entity:/i.test(id)) {
        const entity = host.entities().find((e) => e.urn.toLowerCase() === href.toLowerCase());
        if (!entity) throw new ResourceNotFoundError(href, `No entity ${href} in this vault. List entities with ${TOOL_NAMES[4]}.`);
        const data = { urn: entity.urn, name: entity.name, type: entity.type, aliases: entity.aliases, bundle: entity.bundle, recorded: entity.recorded, references: entity.references.map((r) => ({ path: r.concept.path, title: r.concept.title, id: r.concept.id, role: r.role })) };
        return { contents: [{ uri: href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
      }
      if (!UUID.test(id)) throw new ResourceNotFoundError(href, `${href} is not a MIF id. A concept is urn:mif:<uuid>; an entity is urn:mif:entity:<type>:<slug>.`);
      const r = host.resolve(href, new Date());
      // Two notes with one id: name both, never pick one.
      if ("ambiguous" in r) throw new ResourceNotFoundError(href, `${href} is carried by more than one note: ${r.ambiguous.join("; ")}. Read one by its path with ${TOOL_NAMES[1]}.`);
      if (!("concept" in r)) throw new ResourceNotFoundError(href, `No concept ${href} in this vault. Find concepts with ${TOOL_NAMES[0]} or ${TOOL_NAMES[3]}.`);
      const c = r.concept;
      const text = [`# ${c.title}`, `${c.id} · ${c.path}${c.type ? ` · ${c.type}` : ""}${c.namespace ? ` · ${c.namespace}` : ""}${c.entity_type ? ` · ${c.entity_type}` : ""}`, weighingLine(c.weighing), countsLine(countEdges(host.edges(c.path))), c.body.trim()].join("\n\n");
      return { contents: [{ uri: href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerPrompt(
    PROMPT_NAMES[0],
    { title: "How to use this vault's memory", description: "The usage guide for this vault's MIF memory: what it holds, how to find things, how relationships work, and how far to rely on what you recall." },
    () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: guide(host) } }] }),
  );

  const values = (pick: (c: { entity_type?: string; namespace?: string }) => string | undefined) => (typed: string | undefined) => {
    const seen = new Map<string, number>();
    for (const c of host.concepts()) {
      const v = pick(c);
      if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    const start = (typed ?? "").toLowerCase();
    return [...seen]
      .filter(([v]) => v.toLowerCase().startsWith(start))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 100)
      .map(([v]) => v);
  };

  server.registerPrompt(
    PROMPT_NAMES[1],
    {
      title: "Recall what the vault holds on a topic",
      description: "Recall what this vault's memory holds on a topic, following typed relationships, and report it with its freshness, trust and sources.",
      argsSchema: z.object({
        topic: z.string().min(1).describe("What to recall, in a few words or a question."),
        // The SDK looks for the completion inside the optional wrapper, so completable goes on the inner schema.
        entity_type: completable(z.string().describe("Only this entity type, e.g. constraint."), values((c) => c.entity_type)).optional(),
        namespace: completable(z.string().describe("Only this namespace or below it."), values((c) => c.namespace)).optional(),
      }),
    },
    ({ topic, entity_type, namespace }) => {
      const [search, get, relate, list] = TOOL_NAMES;
      const scope = [entity_type ? `entity type "${entity_type}"` : "", namespace ? `namespace "${namespace}"` : ""].filter(Boolean).join(" and ");
      const text = [
        `Recall what the MIF memory of the vault "${host.vault().name}" holds about: ${topic}`,
        scope ? `Keep to ${scope}.` : "",
        "",
        `1. Find the concepts. If the topic names a title or a code, pass it to ${get}. Otherwise use ${search}${scope ? ` with the matching filter, or ${list} to list by those facts` : ""}. If search is unavailable, say so and use ${list}.`,
        `2. For each concept that matters, read its relationship counts, then use ${relate} to follow the types that bear on the topic, incoming as well as outgoing.`,
        `3. Read what you will rely on with ${get}; pass include: ["citations", "provenance"] where the source of a claim matters.`,
        "4. Report what the vault holds. For every claim, name the concept it comes from. Say which concepts are stale, expired or low in trust, and treat those as history, not current fact. Say plainly what the vault does not hold; do not fill gaps from your own knowledge without marking it as yours.",
      ]
        .filter((l) => l !== "")
        .join("\n");
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    },
  );
}
