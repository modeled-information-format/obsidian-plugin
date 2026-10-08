---
diataxis_type: how-to
title: Search concepts by meaning with mif-cli
description: Connect mif-rs's mif-cli, ingest concepts, and run semantic search and find-similar (desktop only).
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
