---
id: ca9a36df-7dfc-4f82-919e-f290aedddea9
type: semantic
created: 2026-11-27T06:30:00Z
modified: 2026-11-27T06:30:00Z
namespace: _semantic/reference
title: MCP server
tags:
- reference
- mcp
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-11-27T06:30:00Z
  recordedAt: 2026-11-27T06:30:00Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source (src/mcp); tool and prompt names are pinned by tests/mcp.test.ts, and behaviour through a client by evals/mcp-client
relationships:
- type: relates-to
  target: ../how-to/mcp-server.md
- type: relates-to
  target: settings.md
- type: relates-to
  target: ../adr/0002-mcp-server.md
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "Model Context Protocol specification, revision 2026-07-28"
  url: https://modelcontextprotocol.io/specification/2026-07-28
  accessed: 2026-11-26
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "MIF: Modeled Information Format specification"
  url: https://mif-spec.dev/
  accessed: 2026-11-26
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: MCP server
  entity_type: reference-document
description: The plugin's MCP server - its address and security, tools, prompts, resources, the form of its results, its write rules, and what it sends to a listening client.
diataxis_type: reference
---

# MCP server

Desktop only; off until a vault turns it on. Its settings are in
[Settings](settings.md) (the rows that begin "MCP", and "Vault purpose").

## Server

| | |
|---|---|
| Name | `mif-vault` |
| Protocol | Model Context Protocol, revision 2026-07-28; clients of the 2025 revisions are also served |
| Transport | Streamable HTTP, stateless, at `http://127.0.0.1:<port>/mcp` |
| Port | 27182 by default, one per vault; if it is in use the server stays off and says so |
| Authentication | `Authorization: Bearer <token>`; the token is per vault |
| Refused | a `Host` or `Origin` that is not this computer (403), a missing or wrong token (401), any other path (404), a body over 1 MiB (413) |

Every tool and prompt name begins `mif_vault_`, so none collides with the
tools of mif-rs's own MCP servers.

## Read tools

Always offered.

| Tool | What it does | Main options |
|---|---|---|
| `mif_vault_search_concepts` | Finds concepts by meaning, or the concepts nearest to one. Needs `mif-cli` and an ingested bundle. | `query`, `similar_to`, `min_cosine`, `mode`, `entity_type`, `folder`, `bundle`, `include_expired`, `limit`, `offset` |
| `mif_vault_get_concept` | Reads one concept by path, id, title, or a code in its title. | `include_body`, `section`, `max_chars`, `include` (citations, provenance, entities), `include_frontmatter`, `as_of` |
| `mif_vault_list_relationships` | Lists typed relationships of one or several concepts, in both directions. | `direction`, `types`, `depth`, `combine` (each, intersect, union, subtract), `path`, `path_to`, `neighbor_counts`, `counts_only`, `as_of` |
| `mif_vault_list_concepts` | Lists concepts by their facts. | `type`, `namespace`, `entity_type`, `folder`, `bundle`, `title_contains`, `freshness`, `trust`, `relationship`, `group_by`, `sort`, `limit`, `offset` |
| `mif_vault_list_entities` | Lists the entities concepts refer to. | `type`, `name_contains`, `bundle`, `referenced_by`, `include_references`, `group_by_type` |
| `mif_vault_get_status` | Reports on the vault: `graph` (counts, freshness, trust, ontologies, ids carried twice, concepts awaiting review), `store` (vector store coverage), `gaps` (similar concepts with no relationship; relationships between unalike concepts). | `report`, `bundle`, `scope`, `limit`, `offset` |
| `mif_vault_list_entity_types` | Lists the types an entity may be recorded as. | `bundle`, `source`, `name_contains` |

## Write tools

Offered only while **Allow MCP writes** is on.

| Tool | Operations | Asks the user |
|---|---|---|
| `mif_vault_write_concept` | `create`: a new concept, with its relationships, citations and entity references in the same call. `supersede`: a new concept that replaces an existing one, which is kept with its validity ended; the new one takes over the relationships the old one declared. | Before superseding. When the vault already holds something close: keep both, merge, supersede, or write nothing. |
| `mif_vault_edit_concept` | `edit`: the whole text, one section, the summary or the tags. `merge`: other concepts into this one; each is kept, superseded, with its validity ended. | No. |
| `mif_vault_write_relationship` | `add`, `update` (type, strength), `remove`. | Which type, when `add` gives none. Before `update` and `remove`. |
| `mif_vault_write_reference` | `add_citation`, `create_entity`, `add_entity_reference` (by urn or by name). | Which entity, when a name matches several. |
| `mif_vault_ingest_concepts` | Embeds a bundle's new and changed concepts. Changes the vector store and no note. | No. |

## Prompts

| Prompt | Arguments | Offered |
|---|---|---|
| `mif_vault_guide` | none | always |
| `mif_vault_recall` | `topic`, `entity_type`, `namespace` | always |
| `mif_vault_capture` | `what` | with writes on |
| `mif_vault_review_stale` | `namespace`, `limit` | with writes on |
| `mif_vault_curate_links` | `bundle`, `entity_type` | with writes on |
| `mif_vault_consolidate` | `topic` | with writes on |

A client that fills arguments from words typed after a command may split a
topic of several words across them, or pass only the first. `recall` takes a
filter that names nothing in the vault back into its topic, and every prompt
that takes free text tells the model to use all of what was typed.

## Resources

Every resource is addressed by a `urn:mif:` identifier.

| Resource | Address | Served as |
|---|---|---|
| Concept | `urn:mif:<uuid>`, the concept's MIF id | markdown, with its freshness, trust and relationship counts |
| Entity | `urn:mif:entity:<type>:<slug>` | JSON |
| Ontology | `urn:mif:ontology:<id>` | JSON: its entity types, namespaces, and what it extends |

`urn:mif:<uuid>` and `urn:mif:entity:…` are MIF's own identifiers.
`urn:mif:ontology:<id>` is this plugin's convention: the MIF specification
does not define it, and other MIF tools do not know it. Where an ontology
is published (the address concepts declare for it, or its address in the
mif-spec.dev catalog when the local copy is the catalog's own) is reported
as `published_at`, for information. Nothing is served at that address.

A note without a valid id is not a resource; tools address it by path. An
id that two notes carry is never resolved to one of them: both are named.

## Results

- A result is text. It states each concept's freshness (fresh, ageing,
  stale, expired, not yet valid, timeless) and trust, in words, and names
  the tool to use next where that helps.
- `response_format: "json"` returns the same data as JSON text, for a
  program. No structured copy is sent beside the text, and tools declare no
  output schema.
- A result that names concepts also carries a resource link to each.
- An argument a tool does not have is refused, by name.
- Expired and not-yet-valid concepts are left out of lists unless asked
  for, and the result says how many were left out.
- A title or code that several concepts carry resolves to the one valid at
  the time asked about, when there is exactly one; the result names the
  others. Otherwise the candidates are listed.

## Write rules

- A note that is the active editor, or has unsaved text in any editor, is
  not written to; the tool says so.
- A change that would add a schema error is refused, and the error is
  returned.
- The mirrored `## Relationships` and `## Citations` sections are rebuilt
  from the frontmatter; a tool cannot write them.
- A concept an agent writes is marked `sourceType: agent_inferred`. One it
  writes, edits or merges into gets `trustLevel: uncertain`, the client's
  name as `agent`, and `sourceRef: mcp:mif-vault`, and waits in the agent
  review panel. The client's name is what the client says it is.
- Every change to an existing note sets `modified`.
- A new concept's file is named for its title, capitals kept, and never
  overwrites a file.
- An entity is recorded only as a type its bundle has: Person,
  Organization, Technology, Concept, File, or a type a loaded ontology
  defines.
- Writes are limited to **MCP write limit** within **MCP write window**. An
  admitted write counts even if the vault then refuses it.
- Each write raises a notice in Obsidian and appends a line to
  `mcp-audit.log` in the plugin's folder: time, client, action, target,
  outcome.

## Questions for the user

Where the table above says the user is asked, the tool returns an
`input_required` result (MCP elicitation, form mode) and the client calls
again with the answer. A client that does not declare elicitation gets an
error that names the choices and the argument to call again with
(`confirm: true`, `on_duplicate`, `type`, `entity.urn`).

## Notifications

The server advertises list changes for tools, prompts and resources, and
resource subscriptions. To a client listening on `subscriptions/listen`:

| Notification | When |
|---|---|
| `notifications/resources/updated` | a concept, entity or ontology the client subscribed to changed |
| `notifications/resources/list_changed` | one was added or removed |
| `notifications/tools/list_changed`, `notifications/prompts/list_changed` | **Allow MCP writes** was switched |

## Tasks

A client that declares the `io.modelcontextprotocol/tasks` extension on a
`mif_vault_get_status` call with `report: "gaps"` gets a task and polls
`tasks/get`; `tasks/cancel` drops its result. Tasks are held in memory for
ten minutes and do not survive the plugin reloading. Any other client waits
on the request, with progress notifications.

## Relationships

- relates-to [Give an AI agent your vault as memory over MCP](../how-to/mcp-server.md)
- relates-to [Settings](settings.md)
- relates-to [ADR-0002: An MCP server in the plugin](../adr/0002-mcp-server.md)
