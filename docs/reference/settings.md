---
diataxis_type: reference
title: Settings
description: Every setting in Settings → MIF, with its default.
---

# Settings

`npm run check:docs` fails if this table and the plugin's settings disagree.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Mode | `mode` | Observe | Observe validates and fixes on request; Sync also updates `modified`, the `## Relationships` mirror, and an existing `## Citations` section after you edit a concept |
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
