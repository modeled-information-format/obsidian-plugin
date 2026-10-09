---
id: 9ded833c-7ca0-52b9-a70c-6f3b7c362d8d
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _procedural/learning
title: Export JSON-LD and query MIF data
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
  target: ../reference/api.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Export JSON-LD and query MIF data
  entity_type: how-to-guide
description: Export JSON-LD projections, check round trips, and use MIF values in Bases and Dataview.
diataxis_type: how-to
---

# Export JSON-LD and query MIF data

## Export JSON-LD

| Command | Exports |
|---|---|
| **MIF: Export this note as JSON-LD** | the open concept |
| **MIF: Export this note's folder as JSON-LD** | its folder |
| **MIF: Export all bundles as JSON-LD** | every bundle; projections of deleted concepts go to the trash |

Files go to `dist/jsonld/<bundle>/<path>.jsonld` (spec §3.2; change the
folder in settings), byte-identical to MIF's `mif_convert.py emit-jsonld`
except that a whole-number float such as `1.0` is written `1`. They are
derived output: if the vault is a git repository, ignore the folder. To see
`.jsonld` files in the file explorer, turn on **Settings → Files and links →
Detect all file extensions**.

The **MIF JSON-LD** panel (**MIF: Open JSON-LD panel**) shows the open note's
projection live, with **Copy** and **Export**.

## Check round trips

**MIF: Check that every concept round-trips losslessly** converts every
concept to JSON-LD and back and lists any that change (spec Invariant 4).

## Bases

In any base, choose the **MIF table** view. It shows the base's own
properties plus MIF level, freshness, trust, and issue counts for each note,
respecting the base's filters, sort, and grouping.

## Dataview and scripts

`app.plugins.plugins.mif.api` is read-only and computed live:

```js
// DataviewJS
const mif = app.plugins.plugins.mif.api;
dv.table(["Note", "Level", "Freshness", "Trust"],
  mif.concepts().map((c) => [dv.fileLink(c.path), c.level, c.freshness ?? "", c.trust ?? ""]));
```

See the [API reference](../reference/api.md). Plain frontmatter fields (type,
namespace, provenance) are also available to Dataview directly.

## Relationships

- relates-to [Plugin API](../reference/api.md)
