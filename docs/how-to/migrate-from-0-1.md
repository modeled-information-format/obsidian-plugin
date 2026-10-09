---
id: 07bf42f7-e982-517d-af14-9eff39553940
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _procedural/learning
title: Migrate MIF 0.1 notes
tags:
- how-to
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Migrate MIF 0.1 notes
  entity_type: how-to-guide
description: Convert MIF 0.1 notes (slug ids, wiki-link relationships, .memory.md names) to MIF 1.0.
diataxis_type: how-to
---

# Migrate MIF 0.1 notes

Notes in the MIF 0.1 format show a `legacy-0.1` warning.

1. Run **MIF: Migrate version 0.1 notes to 1.0**. The dialog lists every 0.1
   note in your bundles.
2. Click **Migrate**.

Each note gets a UUID `id` (derived from the old id, so reruns give the same
result; the old id is kept in `aliases`), markdown-link relationships with
matching frontmatter, 1.0 field names, and a `.md` name instead of
`.memory.md`. Links from other notes follow the rename.

To migrate one note, use the **Migrate to MIF 1.0** fix on its `legacy-0.1`
diagnostic.
