<!-- diataxis_type: how-to -->

# MIF for Obsidian

An Obsidian plugin for authoring, validating, and syncing
[MIF](https://mif-spec.dev) bundles. Status: in development.

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

## Layout

| Path | What it is |
|---|---|
| `src/engine/` | Obsidian-free MIF engine: parse, JSON-LD projection, round trip, schema validation |
| `src/spikes/` | in-Obsidian experiments (developer commands) |
| `src/main.ts` | Plugin entry: settings, status-bar check, commands |
| `schemas/` | Vendored canonical schemas; `SOURCE.json` records the MIF commit |
| `test-vault/` | Copy of `MIF/examples`, opened in Obsidian for manual and spike runs |
| `tests/fixtures/edge/` | Edge-case bundle (YAML 1.1 scalars, timestamps, CRLF, key order, …) |
| `tests/golden/` | Outputs of the MIF reference converter the engine is tested against |

## Develop

Requires Node 22+ and Python 3 with PyYAML (for regenerating goldens). The
MIF repo is expected at `../MIF`; override with `MIF_REPO`.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run the parity tests:

   ```bash
   npm test
   ```

3. Build and install into the test vault:

   ```bash
   npm run build && npm run install-vault
   ```

4. Open `test-vault` as a vault in Obsidian, trust the plugin, and run
   **Spike B** and **Spike C** from the command palette. Reports are written to
   `test-vault/_spike/`.

After the MIF repo changes, refresh the schemas and goldens, then re-run the tests:

```bash
npm run sync-schemas && npm run golden && npm test
```
