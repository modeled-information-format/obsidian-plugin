<!-- diataxis_type: how-to -->

# MIF for Obsidian

An Obsidian plugin for authoring, validating, and syncing
[MIF](https://mif-spec.dev) bundles. Status: in development.

## Conformance

The plugin implements **MIF 1.4.0 at Level 3 (Full)** (spec §13.3): it reads,
validates, and edits every Level 1–3 feature — identity, namespaces, entity
references, typed relationships with their body mirror, bi-temporal
metadata and decay, W3C-PROV-aligned provenance, embedding references,
citations, compression, and extensions — and projects concepts to JSON-LD
losslessly. Evidence: golden tests against MIF's reference scripts
(`mif_convert.py`, `okf_validate.py`, `migrate_0_1_to_1_0.py`), schema
validation against the vendored 1.4.0 schemas, and a parity oracle against
mif-rs.

## Network use

The plugin works offline. One optional feature uses the network: when
**Settings → MIF → Download ontologies from mif-spec.dev** is on (the
default), and a concept declares an ontology the vault does not have, the
plugin downloads it, and the ontologies it extends, from
`https://mif-spec.dev/ontologies/`. Each file is checked against the sha256
in the published catalog (`index.json`) before use and is cached in the
plugin folder. Nothing about your vault is sent. Turn the setting off to
never contact the network; ontologies in a bundle's `.mif/ontologies/`
folder always work offline.

The optional **mif-cli bridge** (desktop only, off until **Settings → MIF →
mif-cli path** is set) runs mif-rs's `mif-cli` on your machine. The plugin
itself sends nothing; `mif-cli ingest` downloads its embedding model
(`sentence-transformers/all-MiniLM-L6-v2`) from Hugging Face the first time
and caches it. Embeddings are stored in each bundle's `.mif/vectors.db`.

## Using MIF data elsewhere

- **JSON-LD export:** commands export a note, a folder, or every bundle to
  `dist/jsonld/<bundle>/<path>.jsonld` (spec §3.2, the layout of MIF's `emit-jsonld`); the
  **MIF JSON-LD** panel shows the active note's projection and round trip.
- **Bases:** choose the **MIF table** view in any base to see level,
  freshness, trust, and issues beside your properties.
- **Dataview / scripts:** `app.plugins.plugins.mif.api` is read-only:

  ```js
  // DataviewJS
  const mif = app.plugins.plugins.mif.api;
  dv.table(["Note", "Level", "Freshness", "Trust"],
    mif.concepts().map((c) => [dv.fileLink(c.path), c.level, c.freshness ?? "", c.trust ?? ""]));
  ```

  `concept(path)`, `concepts()`, `relations(path)`, and `jsonld(path)` return
  values computed live; nothing is written to frontmatter.

## Documentation

User and maintainer documentation is in [docs/](docs/README.md): a
[getting-started tutorial](docs/tutorial/getting-started.md), how-to guides,
reference (commands, settings, diagnostic codes, API), and explanation.
Security and release verification: [SECURITY.md](SECURITY.md).

## Layout

| Path | What it is |
|---|---|
| `src/engine/` | Obsidian-free MIF engine: parsing, JSON-LD projection, round trip, validation, relationships, ontologies, temporal, citations, compression, export |
| `src/*.ts` | The plugin: manager (vault model and writes), panels, Bases view, graph, mif-cli bridge, API |
| `schemas/` | Vendored canonical schemas; `SOURCE.json` records the MIF commit |
| `tests/` | Vitest suite: goldens from MIF's reference scripts, headless panel tests, fixtures |
| `test-vault/` | Copy of `MIF/examples`; `npm run install-vault` stages the fixtures for manual testing |
| `spikes/mif-wasm/` | mif-rs compiled to WebAssembly: the parity oracle |
| `tools/lint/` | ESLint with Obsidian's review rules (isolated: it needs TypeScript 5's API) |
| `.github/workflows/` | CI, quality gates, and the attested release pipeline (from mif-repo-template) |

## Develop

Requires Node 22+; Python 3 with PyYAML to regenerate goldens; Rust and
`wasm-pack` for the parity oracle. Sibling checkouts are expected at
`../MIF` and `../mif-rs` (override with `MIF_REPO`).

```bash
npm ci && npm run lint:install        # dependencies
npm run lint && npm run typecheck     # ESLint (Obsidian rules), TypeScript
npm test                              # tests, incl. golden parity with MIF's scripts
npm run build && npm run check:mobile # main.js, and the mobile load check
npm run check:docs                    # reference docs match the source
npm run install-vault                 # copy the build into test-vault and stage fixtures
```

Parity oracle: `(cd spikes/mif-wasm && wasm-pack build --release --target
nodejs --out-dir pkg-node)`, after which `npm test` also compares the engine
with mif-rs. Live mif-cli test: `MIF_CLI=/path/to/mif-cli npx vitest run
tests/live-mif-cli.test.ts`.

Keeping up with MIF:

```bash
npm run mif-align -- origin/main                      # test against a MIF ref
MIF_REF=origin/main npm run sync-schemas && npm test  # vendor its schemas
npm run golden                                        # if the reference scripts changed
```
