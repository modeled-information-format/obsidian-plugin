---
id: f6eda7b2-191a-4a22-9f67-4210addbcda6
type: semantic
created: 2026-11-27T06:45:00Z
modified: 2026-11-27T06:45:00Z
namespace: _semantic/decisions
title: "ADR-0002: An MCP server in the plugin"
summary: The plugin serves a vault to MCP clients on the same computer as a weighed, pull-only memory - read tools always, write tools behind a switch, agent writing attributed and reviewed - built on the MCP TypeScript SDK v2 for protocol revision 2026-07-28 and evaluated through a real client.
tags:
- adr
- mcp
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-11-27T06:45:00Z
  recordedAt: 2026-11-27T06:45:00Z
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the decision log kept while the server was designed and built, 2026-11-26 to 2026-11-27; decisions marked (owner) were made by the project owner
relationships:
- type: relates-to
  target: 0001-engine-implementation.md
- type: relates-to
  target: ../reference/mcp.md
- type: relates-to
  target: ../explanation/vault-as-agent-memory.md
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "Model Context Protocol specification, revision 2026-07-28"
  url: https://modelcontextprotocol.io/specification/2026-07-28
  accessed: 2026-11-26
- "@type": Citation
  citationType: repository
  citationRole: source
  title: "Model Context Protocol TypeScript SDK"
  url: https://github.com/modelcontextprotocol/typescript-sdk
  accessed: 2026-11-26
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: "ADR-0002: An MCP server in the plugin"
  entity_type: decision-record
---

# ADR-0002: An MCP server in the plugin

## Status

Accepted, 2026-11-27.

## Context

A MIF vault holds what its owner knows as concepts with typed relationships,
validity, decay, provenance and trust. AI agents work better with memory,
and the usual memory hands an agent old text as though it were current
fact. The plugin already had the vault's model, its relationship index, a
safe path for writing notes, and a bridge to `mif-cli` for semantic search.
The question was whether to expose these to agents over the Model Context
Protocol, and if so how.

The work began as a spike with a gate: go on only if agents with the server
answered multi-hop questions more accurately than agents reading the files,
without costing more. On twenty questions over a vault of 1,306 concepts
the result was 20 against 18 at about the same cost, the two misses being
questions about what points at a concept. The owner judged the gate passed.

## Decision drivers

1. What an agent recalls must arrive with its age and trust, and must be
   asked for, never pushed.
2. A vault is private: nothing is served until its owner turns it on, per
   vault, and nothing leaves the computer.
3. An agent's writing must be attributed, reviewable, and never silent; a
   note being edited must never be written to.
4. Follow the current protocol revision and its official SDK; do not
   hand-roll what the SDK provides.
5. Names must not collide with mif-rs's own MCP servers.
6. Mobile must be unaffected: `main.js` loads no Node module and runs no
   server code there.

## Options considered

| Question | Chosen | Set aside, and why |
|---|---|---|
| Where the server runs | Inside the plugin | A separate headless program: it would have to rebuild the vault model and could not see unsaved editors. |
| Transport | Streamable HTTP on `127.0.0.1`, one port per vault | stdio: an Obsidian plugin cannot be a child process of the client. A stdio bridge for Claude Desktop was considered and not built. |
| Protocol code | The MCP TypeScript SDK v2 | A hand-written JSON-RPC handler: revision 2026-07-28 changed enough (no handshake, per-request metadata, input-required results) that this would have been wrong at once. |
| Tool surface | Few tools with options: seven read, five write | One tool per ability: the tool list is a fixed cost in every session. |
| Results | Text, with JSON text on request | Text and structured content together: the client tested shows the model only the structured copy. |
| How `mcp.cjs` reaches users | Compressed inside `main.js`, unpacked on desktop | A download on first use; folding it into `main.js` as code; manual installation. |
| How it is tested | Unit tests, plus evals through Claude Code against an in-memory server and a live vault | Unit tests alone: they could not see what a client does to a request. |

## Decision

The plugin serves each vault that turns it on to MCP clients on the same
computer. The decisions, in the order they were numbered while the work was
done, grouped by subject. "(owner)" marks a decision the project owner
made; a decision that reverses an earlier one says so.

### Shape

| | Decision | Why |
|---|---|---|
| M1 | Use: agent memory shared across MCP clients. | Read and write tools; not an export pipeline. |
| M2 | The server runs inside the plugin, desktop only, with Obsidian open. No headless server. | A closed vault has no memory available. Node's `http` is loaded lazily through `window.require`, like the mif-cli bridge, so `check:mobile` still passes. |
| M3 | Transport: Streamable HTTP on `127.0.0.1`. No stdio. | A client cannot spawn a server that lives inside Obsidian. A stdio bridge is built only if Phase 0 shows a needed client is stdio-only. |
| M4 | Protocol: MCP 2026-07-28 through SDK v2, not hand-rolled JSON-RPC. | The revision is stateless and requires `server/discover`, header validation and `resultType`; the SDK serves it and 2025-era clients from one handler. Adds `@modelcontextprotocol/server` and `zod` (v4) to the bundle. |
| M5 | One server per vault, opt-in per vault, off by default. | Each vault has its own port, token and purpose line. No cross-vault graph. |
| M6 | The port is a per-vault setting. | Several vaults can serve at once. A port already in use leaves the server off with a notice; it never falls back to another port. |
| M7 | Graph scope: typed relationships, entities and ontology, semantic neighbours, citations and provenance. | Typed and semantic edges are returned separately; semantic edges carry cosine. |
| M8 | Recall is weighed. | Every result carries freshness state and strength, trust, provenance, MIF level and open diagnostics. Expired concepts are excluded unless asked for. |
| M9 | Recall is pull-only. | No hooks, no injected context. Tool descriptions and results tell agents to treat recall as evidence and cite it (M15). |
| M10 | The design does not inherit mnemonic's architecture or conclusions. | Choices are made from the plugin and the specifications. |
| M26 | Phase 1 adds abilities to few tools with options, not one tool per ability: six tools where this plan first listed about seventeen. | Each tool definition measured 3 to 7 KB, sent in every session. Similarity and duplicate checks live in search; sources in get-concept; shortest path in relationships; listing, grouping and count filters in one listing tool; graph, store and gap reports in one status tool. |
| M33 | The MCP server code is a separate file, `mcp.cjs`, loaded on desktop only when a vault turns the server on (owner, 2026-11-26). | `main.js` is 493 KiB (478 before any MCP work) and carries no SDK; `mcp.cjs` is 377 KiB. `check:mobile` fails if server code reaches `main.js`. The release workflow stages `mcp.cjs`. How it reaches users through Obsidian's installer is open. |
| M34 | The default port is 27182 (owner, 2026-11-26). | It lies in a block IANA lists as unassigned (27018–27344), in the registered range, clear of the ephemeral range the system hands out. |
| M35 | The local server is for clients that run on the same machine and can be given a localhost URL, such as Claude Code through `.mcp.json` or `claude mcp add` (owner, 2026-11-26). | A custom connector in Claude's settings cannot reach `127.0.0.1`, so the planned Claude Desktop connector test was dropped as pointless. This is the owner's statement and matches the documentation; it was not tested. |
| M54 | `mcp.cjs` ships inside `main.js`: a compressed copy that desktop unpacks into the plugin folder the first time a vault turns the server on (owner, 2026-11-26). | Obsidian's installer fetches only `main.js`, `manifest.json` and `styles.css`. No network is needed and no second download can fail. `main.js` grows by the compressed size for every user, mobile included; the server code still never loads on mobile. To build in Phase 4. |
| M55 | No stdio bridge for Claude Desktop in this release (owner, 2026-11-26). | Claude Code through `.mcp.json` is the supported client (M35). Revisit on demand. |

### Reading

| | Decision | Why |
|---|---|---|
| M14 | Every semantic capability the plugin already has is served: search by meaning, similar concepts, duplicate check, relationship-gap report, store coverage and ingest. Semantic search ships in Phase 1, not later. | The tool layer calls the existing mif-cli bridge (`MifCli`); nothing is reimplemented. Pruning the store stays a human-only command. |
| M15 | Guidance never depends on `server/discover` instructions, because clients may not call it. | Tool descriptions carry the workflow, results state their weighing in plain words, and errors and results name the next tool. See *Guidance*. |
| M16 | Concepts, entities and ontologies are also MCP resources. | Tool results link to concepts instead of pasting them; a user can attach a concept to a chat. |
| M17 | Clients can subscribe to changes. | An agent learns that a concept changed in Obsidian before acting on a stale copy. |
| M18 | The server offers prompts for the common memory workflows. | Recall, capture, review and curation are one user action in clients that surface prompts. |
| M22 | An agent's read does not count as access for freshness. | Read tools stay read-only. Revisit if recalled memories should stay fresh; see *Open questions*. |
| M23 | Resource URIs and tool identifiers are the records' canonical MIF identifiers: `urn:mif:<uuid>` for a concept, `urn:mif:entity:…` for an entity, the declared `uri` for an ontology. | One identifier across notes, JSON-LD, the vector store's `urn:mif:vector:<id>`, and MCP. Paths are accepted and returned as a secondary handle. |
| M24 | No name collides with mif-rs's `mif-mcp` or `mif-rh-mcp`. Tools and prompts carry the `mif_vault_` prefix; the server is named `mif-vault`; a client entry is `mif-vault-<vault>`. | A test pins the other servers' tool names and fails on a collision, with or without the prefix. |
| M25 | Tools keep both an output schema with structured content and the text result (owner, 2026-11-26), knowing the structured copy measured twice the size of the text. | Programs calling the tools get typed output. The cost is managed by keeping structured rows lean, not by dropping them. Reversed by M60. |
| M27 | Nothing in this plan is narrowed, deferred or dropped without the owner's approval first (owner, 2026-11-26). | A planned item that looks costly, blocked or in tension with another goal is put to the owner as a question before its scope changes. A leaner mode may be offered as an option; making it the default needs approval. |
| M28 | An ontology that no concept gives a uri is addressed by its canonical address in the mif-spec.dev catalog (owner, 2026-11-26). | The plugin learns the catalog when the MCP server starts, if "Download ontologies" is on: one request to mif-spec.dev per session, cached. An ontology the catalog does not list, such as a custom local one, has no address and is not a resource. Address reversed by M63: the catalog address is now information only. |
| M29 | Lists are compact by default (owner, 2026-11-26). This amends M8. | One line per concept, with freshness and trust stated only where a concept calls for caution. `detail: "full"` states the full weighing of every concept, and reading a single concept always does. |
| M30 | Tool arguments are completed through their schemas (owner, 2026-11-26). | The protocol's completion request reaches prompts and resource templates only. Each tool argument that takes a vault value carries the vault's own values as JSON Schema `examples`, rebuilt per request, and an unknown value is refused with the valid ones named. |
| M31 | An ontology with no declared uri and no catalog address is addressed as `urn:mif:ontology:<id>` (owner, 2026-11-26). | Custom local ontologies are resources. This identifier form is new: the MIF specification does not define it. |
| M32 | A local copy of a catalog ontology is served at the catalog's address only when its sha256 matches the catalog's (owner, 2026-11-26). | An edited copy is addressed as `urn:mif:ontology:<id>` and says it differs. Address reversed by M63: the catalog address is now information only. |
| M52 | A title or code that several concepts carry resolves to the one valid at the time asked about, when there is exactly one; the answer lists the others. An id or a path never resolves this way. | Found by the workflow evaluation: a superseded record and its replacement share a title, so every lookup by code had become ambiguous. Added while building; not an owner decision. |
| M58 | M22 stands: an agent's read never counts as access for freshness, with writes on or off (owner, 2026-11-26). | Read tools stay read-only for every vault. |
| M59 | `urn:mif:ontology:<id>` (M31) is this plugin's own convention and is not proposed to the MIF specification (owner, 2026-11-26). | To be documented as such in the reference pages. Other MIF tools do not know the form. |
| M60 | Tool results are text only by default; no structured content and no output schemas. Reverses M25 (owner, 2026-11-27). | Observed through a proxy: given both, Claude Code hands the model the structured JSON and drops the text, and the text is where a result states its weighing in words and what to do next (M15). A program asks for `response_format: "json"` and gets the data as JSON text. The structured copy survives behind `ServerOptions.structured`, which the unit tests use. Results on the wire halve. |
| M63 | Every ontology is addressed as `urn:mif:ontology:<id>`. Reverses the addresses of M28 and M32 (owner, 2026-11-27). | The owner judged the `https://mif-spec.dev/` address a mistake. Where an ontology is published (the uri concepts declare for it, or the catalog's address when the copy's sha256 matches) is still reported, as `published_at`, for information; nothing is served there. Every resource the server lists is now a `urn:mif:` id. The form remains the plugin's own convention (M59). |
| M66 | Every tool refuses an argument it does not have, by name. | Found while writing the two-bundle cases: `bundle` passed to `mif_vault_list_concepts`, which had no such argument, was dropped and every concept in the vault came back as if that were the answer. `list_concepts` and `list_entities` also gained the `bundle` filter they lacked. Added while building; not an owner decision. |

### Writing and review

| | Decision | Why |
|---|---|---|
| M11 | Writes are direct, through `MifManager`, behind a separate "Allow writes" switch that is off by default. | Format-preserving, schema-validated, never while a note has unsaved edits. The tool list is the same for every client, as the spec requires. |
| M12 | Destructive writes are confirmed by elicitation when the client supports it. | A tool returns `input_required`; the client retries with the answer. |
| M13 | No Logging, Sampling or Roots. | All three are deprecated in 2026-07-28. Writes are audited in the plugin's own log. |
| M19 | Elicitation is used for choices, not only for confirming destructive writes. | The human picks between candidate entities, relationship types, and merge versus supersede. |
| M20 | Agent-written concepts are marked as such and enter a review queue in Obsidian. | The human promotes or rejects them; recall reports the review state. The write-side answer to "not blindly". |
| M21 | Provenance records which client wrote each concept. | Taken from the request's client identity, which is self-reported and not verified by the protocol. |
| M36 | Writes are four tools, each with an `operation` (owner, 2026-11-26). | `mif_vault_write_concept` (create, supersede), `mif_vault_write_relationship` (add, update, remove), `mif_vault_write_reference` (add_citation, create_entity, add_entity_reference), `mif_vault_ingest_concepts`. Nine separate tools would have added about as much again to the 34 KB tool list. |
| M37 | A concept an agent writes is always marked `provenance.sourceType: agent_inferred`, `trustLevel: uncertain`, with `agent`, `agentVersion` and `sourceRef: mcp:mif-vault` (owner, 2026-11-26). | These are the fields MIF §12 defines; none is invented. The agent cannot choose its own trust. The client name is self-reported and is used for attribution only. |
| M38 | Review promotes by trust level: the user picks one, `user_stated` by default, and `sourceType` and `agent` stay as recorded (owner, 2026-11-26). | Who wrote a concept is history; what the user thinks of it is trust. |
| M39 | Writes are limited to 30 in 10 minutes per vault, both numbers settable (owner, 2026-11-26). | A vault has one token, so per vault is per token. An admitted write counts even if the vault then refuses it. |
| M40 | The agent names the folder a new concept goes in; by default a folder named for its type, or beside the concept it supersedes (owner, 2026-11-26). |  |
| M41 | An agent may change the frontmatter of any concept and the mirrored Relationships and Citations sections. Superseded in part by M44: it may now also edit a concept's text (owner, 2026-11-26). | The first form of this decision kept prose out of reach. |
| M42 | Rejecting a concept in review moves it to the trash (owner, 2026-11-26). | It can be restored. A concept it superseded becomes valid again if that write is what ended its validity; this second part was added while building and is not an owner decision. |
| M43 | Every write raises a notice in Obsidian, and the status bar shows how many concepts wait for review (owner, 2026-11-26). | Every write is also appended to `mcp-audit.log` in the plugin folder. |
| M44 | A fifth write tool, `mif_vault_edit_concept`, edits a concept's text and merges concepts (owner, 2026-11-26). | `edit` replaces the whole text, one section, the summary or the tags. `merge` gives the surviving concept the merged text and the others' relationships, citations and entity references. The mirrored sections are always rebuilt from the frontmatter. |
| M45 | A concept an agent edits or merges into goes back to review: `trustLevel: uncertain`, the client as `agent`, `sourceRef: mcp:mif-vault`; `sourceType` is kept (owner, 2026-11-26). | The review queue is every concept with trust `uncertain` and either `sourceType: agent_inferred` or that `sourceRef`. |
| M46 | A merged-in concept is kept, with its validity ended, and the survivor declares `supersedes` to it (owner, 2026-11-26). | Relationships other concepts declare to it are left as they are. |
| M47 | Edit and merge run without asking the user first (owner, 2026-11-26). | The notice, the return to review and the audit log are the checks. Superseding, and updating or removing a relationship, still ask. |
| M48 | An entity can be recorded only as a type its bundle has: one of five core types (Person, Organization, Technology, Concept, File) or a type a loaded ontology defines; `mif_vault_list_entity_types` lists them (owner, 2026-11-26). | The core five are the ones the plugin's own "New entity" dialog offers, and are in the plugin. `mif-base` is not shipped with the plugin (it is downloaded when a concept declares an ontology) and defines no entity types, so it could not be the floor. |
| M49 | A citation's `accessed` date is written as `YYYY-MM-DD` in UTC (owner, 2026-11-26). | MIF's citation schema types `accessed` and `date` as `format: date`, so the value cannot carry a time or a zone; the plugin reports anything else as an error. Writing a zoned timestamp there needs a change to the MIF specification first. |
| M53 | A superseding concept takes over the relationships the old one declared, with their strength (owner, 2026-11-26). | All but the old one's own `supersedes`, and not one the new concept already declares. Relationships that other concepts declare to the old one are left pointing at it. |
| M56 | A relationship another concept declares to a superseded concept is left pointing at it (owner, 2026-11-26). Reversed by M68. | The old record shows as expired and superseded, and a reader follows `supersedes` to the new one. A supersession changes two notes, never the rest of the vault. |
| M57 | A concept an agent creates is named for its title with the capitals kept, words joined by hyphens (owner, 2026-11-26). | `API-Rate-Limit-Policy.md`, not `api-rate-limit-policy.md`. A name counts as taken if any file has it in any case. The plugin's own "New concept" command is unchanged. |
| M67 | A concept's `modified` date follows every change to it: an edit made in Obsidian, in either mode, and a change an MCP client makes (owner, 2026-11-27). | Found in the owner's client check: a note edited in Obsidian kept its old `modified`, because only Sync mode stamped it. Observe mode now sets `modified` once the user leaves an edited concept, under the same never-while-typing rule, and still leaves the mirrored sections alone; only Sync rewrites those. Only typing in the active editor counts as an edit: Obsidian reloading a note that changed on disk (a sync, a git checkout) into an open tab is not stamped. That an MCP client's change also moves the date, and the typing-only rule, were added with it and are not the owner's wording. |
| M68 | When a concept is superseded, or merged into another, each relationship another concept declared to it is pointed at its replacement, in that concept's frontmatter and mirrored section; rejecting the replacement in review points them back. A "supersedes" relationship is never moved. A note that is being edited is left as it is and reported. Reverses M56 (owner, 2026-11-27). | The owner reopened M56: a reader following a relationship should arrive at what is valid now, not at an expired record. The old concept stays reachable through `supersedes`. |

### Live updates and tasks

| | Decision | Why |
|---|---|---|
| M50 | The relationship-gap report runs as a task for a client that declares the Tasks extension, `io.modelcontextprotocol/tasks` (owner, 2026-11-26). | Any other client waits on the request with progress, as before. The SDK (2.4.0) has no runtime for tasks, so the store and the `tasks/get` and `tasks/cancel` methods are the plugin's own (`src/mcp/tasks.ts`). |
| M51 | The three curation prompts are listed only while writes are on, like `mif_vault_capture` (owner, 2026-11-26). | A prompt-list-changed notification goes out with the tool-list one when the switch flips. |

### Evaluation

| | Decision | Why |
|---|---|---|
| M61 | The server is also evaluated through a real client: `evals/mcp-client`, Claude Code run headless through a recording proxy (owner, 2026-11-27). | Unit tests call the server with the SDK client and well-formed arguments and cannot see what a client does before a request is made. `npm run eval:mcp-client`. |
| M62 | A prompt that takes free text tells the model to take everything typed after the command when the client cut it short, and the recall prompt takes a filter that names nothing in the vault back into its topic. | Claude Code splits a prompt's arguments on spaces, quotes or not, and passes only the first word to a one-argument prompt. The server cannot see the rest; the model can. Added while fixing what the client check found; not an owner decision. |
| M64 | The client evals cover every tool operation, in three kinds of case: client, directed and agent (owner, 2026-11-27). | Asked for after the first 21 cases were judged too thin to support the claim. Directed cases are checked on the recorded call and the vault, never on the model's wording, and can be replayed at the server with `--dry`; agent cases run three times and must pass in most. What is not covered is listed in `evals/mcp-client/README.md` with the reason for each. |
| M65 | The evals run by default against an in-memory server: the real endpoint, service, host and manager over the unit tests' stub vault (owner, 2026-11-27). | No Obsidian, a clean vault for every mode, and settings the runner can change, so the suite runs anywhere `claude` is signed in. It has no mif-cli, so the cases that need the vector store run against a live vault (`--server live`). |

## Consequences

- An agent can use a vault as memory and is told, with everything it reads,
  how fresh and how trusted it is.
- The plugin can open a loopback port. It is off by default, per vault,
  bound to `127.0.0.1`, and guarded by a token and by `Host` and `Origin`
  checks.
- `main.js` grows by about 150 KiB, the compressed server code. Mobile
  carries it and never runs it.
- Only clients on the same computer that accept a `localhost` address can
  connect. Claude Code can; a connector in Claude's web or desktop settings
  cannot.
- The plugin depends on the MCP SDK and on Zod. Two things lean on SDK
  behaviour that is not part of its documented surface: returning a task
  from a tool that declares an output schema, and refusing unknown
  arguments by making every input schema strict. Tests fail if either
  changes.
- Observe mode, which wrote nothing on its own, now sets `modified` on a
  concept the user has edited.
- What a client does with prompts, resources, questions and notifications
  is the client's. The project records what Claude Code does and tests
  against it.

## Closed questions

Each was raised while the work was done and closed by the owner on
2026-11-27. None is outstanding.

- Relationships that point at a superseded concept: re-pointed at its
  replacement (M68).
- Proposing `urn:mif:ontology:<id>` to the MIF specification: no action.
  It stays the plugin's own convention (M59).
- A citation's `accessed` date cannot carry a time zone, because MIF types
  it as a date: no action. It is written as a date.
- The Tasks extension: Claude Code declares it on discovery and not on tool
  calls, so the gap report is never a task for it: no action. The server
  serves a task to any client that asks for one.

## Relationships

- relates-to [ADR-0001: MIF engine implementation for the Obsidian plugin](0001-engine-implementation.md)
- relates-to [MCP server](../reference/mcp.md)
- relates-to [A vault as an agent's memory](../explanation/vault-as-agent-memory.md)
