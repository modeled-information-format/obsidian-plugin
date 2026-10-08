---
diataxis_type: reference
title: Plugin API
description: The read-only API other plugins and DataviewJS can call.
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
