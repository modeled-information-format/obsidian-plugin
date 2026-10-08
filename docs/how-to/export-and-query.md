---
diataxis_type: how-to
title: Export JSON-LD and query MIF data
description: Export JSON-LD projections, check round trips, and use MIF values in Bases and Dataview.
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
