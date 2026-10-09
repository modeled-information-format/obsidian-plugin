---
id: eba26493-70d0-5176-926f-23dd9113fc34
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-09T10:47:10Z
namespace: _procedural/learning
title: Fix what the diagnostics report
tags:
- how-to
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
relationships:
- type: relates-to
  target: ../reference/diagnostics.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Fix what the diagnostics report
  entity_type: how-to-guide
description: Find problems in one note or a whole bundle, apply quick fixes, and choose between Observe and Sync mode.
diataxis_type: how-to
---

# Fix what the diagnostics report

## Check one note

Click the `MIF L…` status bar item, or run **MIF: Open diagnostics**. (Obsidian
on phones and tablets has no status bar: the level is shown at the top of the
diagnostics panel instead.) Each
diagnostic shows its severity, message, the line it refers to (click to jump
there), and quick-fix buttons. Every code is listed in the
[diagnostics reference](../reference/diagnostics.md).

- **Errors** make the concept fail the MIF schema (status bar `MIF ✗`).
- **Warnings** are real problems that do not change the level.
- **Info** notes are advisory: suggestions, level gaps, and checks the spec
  leaves open (ontologies, namespaces, provenance ranges).

## Check the whole bundle

Run **MIF: Open bundle report**. Filter by path, level, provenance trust, or
**Issues only**; click a note to open it. **Rescan** re-reads every note.

## Apply fixes

Click a fix button. Fixes edit only the lines involved; the rest of the
frontmatter keeps its formatting. If a fix cannot be applied without changing
other values, nothing is written and a notice explains why.

Common ones:

| Problem | Fix |
|---|---|
| Windows line endings (`crlf`) | Convert line endings to LF |
| A value Obsidian would rewrite (`yaml-ambiguous`, e.g. `yes`, `010`) | Keep what Obsidian shows, or keep the MIF reading |
| Obsidian's Properties panel changed a value (`rewritten`) | Restore it, or keep the new value |
| `id` is not a UUID (`id-not-uuid`) | Replace it with a new UUID, keeping the old one as an alias |
| Body and frontmatter relationships disagree (`mirror-drift`) | Regenerate the body, or add body-only lines to frontmatter |

## Choose a mode

**Settings → MIF → Mode**:

- **Observe** (default): the plugin validates and fixes only when you click.
- **Sync**: once you leave a concept you edited, it also sets `modified`,
  regenerates the `## Relationships` mirror, and updates an existing
  `## Citations` section. It never writes into a note while you are typing
  in it, and these automatic updates raise no notices.

## Relationships

- relates-to [Diagnostic codes](../reference/diagnostics.md)
