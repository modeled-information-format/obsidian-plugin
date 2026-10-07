<!-- diataxis_type: how-to -->

# MIF for Obsidian

An Obsidian plugin for authoring, validating, and syncing
[MIF](https://mif-spec.dev) bundles. Status: in development.

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
