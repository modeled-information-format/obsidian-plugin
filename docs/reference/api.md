---
id: b0372a3e-d945-577c-a240-8dbd99acee4e
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _semantic/reference
title: Plugin API
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
  name: Plugin API
  entity_type: reference-document
description: The read-only API other plugins and DataviewJS can call.
diataxis_type: reference
---

# Plugin API

```js
const mif = app.plugins.plugins.mif.api; // version 1
```

Everything is computed live from the notes; nothing writes.

| Member | Returns |
|---|---|
| `version` | `1` |
| `concept(path)` | `MifConceptInfo`, or `undefined` if the note is not a concept in a bundle |
| `concepts()` | `MifConceptInfo[]` for every concept, sorted by path |
| `relations(path)` | `{ outgoing: MifRelation[], incoming: MifRelation[] }` |
| `jsonld(path)` | A copy of the note's JSON-LD projection, or `undefined` |

`MifConceptInfo`:

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Vault path |
| `id` | string? | Frontmatter `id` |
| `type` | string? | semantic / episodic / procedural |
| `namespace` | string? | Frontmatter `namespace` |
| `level` | 0–3 | MIF conformance level (0 = fails the schema) |
| `errors`, `warnings` | number | Diagnostic counts |
| `freshness` | string? | fresh / ageing / stale / expired / not-yet-valid / timeless |
| `strength` | number? | Decay strength, 0–1 |
| `trust` | string? | `provenance.trustLevel` |
| `compressed` | boolean | Has `compressedAt` |

`MifRelation`: `type` (kebab-case token), `target` (as written), `path`
(vault path of the other concept, when it resolves).
