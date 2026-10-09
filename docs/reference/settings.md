---
id: a566da52-b775-5391-9701-f4efd7b5231e
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-09T10:47:10Z
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
| Mode | `mode` | Observe | Observe validates and fixes on request; Sync also updates `modified`, the `## Relationships` mirror, and an existing `## Citations` section of a concept you edited, once you leave it (never while you are typing in it) |
| Bundle roots | `bundleRoots` | the whole vault | Folders that are MIF bundles, one per line; an empty line is the vault root; a note belongs to the deepest matching root |
| Excluded folders | `excludedFolders` | `_spike`, `templates` | Folders never treated as MIF |
| Download ontologies from mif-spec.dev | `downloadOntologies` | on | Fetch declared ontologies (and their `extends`), verified by sha256, cached in the plugin folder; the trash button clears the cache |
| Default ontology | `defaultOntology` | `mif-base` | Namespace hints for concepts that declare no ontology |
| Thresholds — fresh | `freshThreshold` | 0.75 | Decay strength at or above which a concept is *fresh* |
| Thresholds — ageing | `ageingThreshold` | 0.5 | At or above: *ageing*; below: *stale* |
| Freshness dots in the file explorer | `explorerBadges` | on | Colour concepts in the file explorer by freshness |
| Track access | `accessTracking` | off | Update `accessCount` / `lastAccessed` on open, at most hourly per note |
| JSON-LD export folder | `exportFolder` | `dist/jsonld` | Where JSON-LD exports go |
| mif-cli path (desktop) | `mifCliPath` | empty (off) | Absolute path to mif-rs's `mif-cli`; **Test** runs it |
| Developer commands | `showDevCommands` | off | Show the spike commands and write a developer log to the plugin folder |
