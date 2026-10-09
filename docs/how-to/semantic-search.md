---
id: f069aae6-9344-56a7-9071-877176a455d6
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _procedural/learning
title: Search concepts by meaning with mif-cli
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
  name: Search concepts by meaning with mif-cli
  entity_type: how-to-guide
description: Connect mif-rs's mif-cli, ingest concepts, and run semantic search and find-similar (desktop only).
diataxis_type: how-to
---

# Search concepts by meaning with mif-cli

Desktop only. Uses [mif-rs](https://github.com/modeled-information-format/mif-rs)'s
`mif-cli`; the plugin itself sends nothing over the network.

## 1. Connect the binary

1. Build or download `mif-cli` (`cargo build --release -p mif-cli` in mif-rs).
2. **Settings → MIF → mif-cli path:** the absolute path to the binary, then
   **Test** — a notice shows its version.

## 2. Ingest

- **MIF: Ingest this note into the vector store** — the open concept.
- **MIF: Ingest this bundle into the vector store** — every concept in the
  bundle; the notice lists any `mif-cli` refused (for example, schema-invalid
  notes) and why.

Embeddings go to the bundle's `.mif/vectors.db`. The first ingest downloads
the embedding model `all-MiniLM-L6-v2` from Hugging Face and caches it.
Re-ingest notes after editing them.

## 3. Search

- **MIF: Semantic search** — type a query and press Enter; results are ranked
  by similarity, click one to open it.
- **MIF: Find concepts similar to this note** — concepts closest to the open
  one (ingest it first).
