---
id: a566da52-b775-5391-9701-f4efd7b5231e
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-11-25T18:53:07Z
namespace: _semantic/reference
title: Settings
tags:
- reference
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: high_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source; command, setting, and diagnostic names are checked against the source by scripts/check-docs.mjs
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "MIF: Modeled Information Format specification"
  url: https://mif-spec.dev/
  accessed: 2026-10-09
- "@type": Citation
  citationType: specification
  citationRole: methodology
  title: "Diátaxis: Reference"
  url: https://diataxis.fr/reference/
  accessed: 2026-10-09
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Settings
  entity_type: reference-document
description: Every setting in Settings → MIF, with its default.
diataxis_type: reference
---

# Settings

`npm run check:docs` fails if this table and the plugin's settings disagree.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Mode | `mode` | Observe | Both modes update `modified` on a concept you edited, once you leave it (never while you are typing in it). Observe otherwise validates and fixes on request; Sync also updates the `## Relationships` mirror and an existing `## Citations` section then |
| Bundle roots | `bundleRoots` | the whole vault | Folders that are MIF bundles, one per line; an empty line is the vault root; a note belongs to the deepest matching root |
| Excluded folders | `excludedFolders` | `_spike`, `templates` | Folders never treated as MIF |
| Download ontologies from mif-spec.dev | `downloadOntologies` | on | Fetch declared ontologies (and their `extends`), verified by sha256, cached in the plugin folder; the trash button clears the cache |
| Default ontology | `defaultOntology` | `mif-base` | Namespace hints for concepts that declare no ontology |
| Thresholds — fresh | `freshThreshold` | 0.75 | Decay strength at or above which a concept is *fresh* |
| Thresholds — ageing | `ageingThreshold` | 0.5 | At or above: *ageing*; below: *stale* |
| Freshness dots in the file explorer | `explorerBadges` | on | Colour concepts in the file explorer by freshness |
| Track access | `accessTracking` | off | Update `accessCount` / `lastAccessed` on open, at most hourly per note |
| JSON-LD export folder | `exportFolder` | `dist/jsonld` | Where JSON-LD exports go |
| mif-cli path (desktop) | `mifCliPath` | empty (search) | Absolute path to mif-rs's `mif-cli` (0.13.0 or later), used as given. Empty: the first `mif-cli` found on `PATH`, then in `~/.cargo/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` (Windows: `mif-cli.exe` on `PATH`, then `~\.cargo\bin`); relative `PATH` entries are skipped. **Test** runs it and shows which binary |
| Background ingest | `backgroundIngest` | off | Desktop, with mif-cli and an existing vector store: ingest a concept a few seconds after it is added or changed, and catch up on everything new or changed when Obsidian starts. Updates the store only; never writes a note and never starts a store |
| Write the embedding reference into notes | `writeEmbeddingReference` | on | After an ingest you start, write the `embedding` block (model, version, dimensions, vector address) into the note, once you have left it. Off leaves notes untouched. Background ingest never writes it. Blocks already written are left as they are |
| Duplicate threshold | `duplicateThreshold` | 0.55 | Cosine similarity at or above which a new concept is reported as a likely duplicate |
| Similar threshold | `similarThreshold` | 0.55 | Cosine similarity at or above which two unrelated concepts are a relationship gap |
| Mislink threshold | `mislinkThreshold` | 0.1 | Cosine similarity at or below which a typed relationship is reported as a possible mislink |
| MCP server (desktop) | `mcpEnabled` | off | Serve this vault's MIF concepts, typed relationships, and semantic search to MCP clients on `127.0.0.1`. Read-only unless **Allow MCP writes** is on. Per vault; off until turned on |
| MCP port | `mcpPort` | 27182 | The localhost port this vault's MCP server listens on. Each open vault needs its own. If the port is in use the server stays off and says so; it never moves to another port |
| MCP token | `mcpToken` | generated | Bearer token an MCP client must send. Generated the first time the server is turned on; **Regenerate** replaces it at once |
| Allow MCP writes | `mcpAllowWrites` | off | Let MCP clients create, edit, merge, and supersede concepts, and add, change, or remove typed relationships, citations, and entity references. A concept a client writes is marked `agent_inferred`, and one it writes, edits, or merges has trust `uncertain` until reviewed in the agent review panel. Every write shows a notice and is logged to `mcp-audit.log` in the plugin folder. A note with unsaved edits is never written |
| MCP write limit | `mcpWriteLimit` | 30 | How many writes MCP clients may make within the write window. Past it a write is refused until earlier ones age out |
| MCP write window | `mcpWriteWindowMinutes` | 10 | The length of the write window, in minutes |
| Vault purpose | `mcpPurpose` | empty | One line telling an agent what this vault's memory is for |
| Developer commands | `showDevCommands` | off | Show the spike commands and write a developer log to the plugin folder |
