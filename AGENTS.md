---
id: 2211dd05-d9d0-5038-816c-d8134303bdc3
type: procedural
created: 2026-10-09T09:55:09Z
modified: 2026-10-09T11:00:24Z
namespace: _procedural/learning
title: AGENTS.md
tags:
- how-to
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-09T09:55:09Z
  recordedAt: 2026-10-09T09:55:09Z
  ttl: P1Y
relationships:
- type: relates-to
  target: docs/README.md
- type: relates-to
  target: README.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: AGENTS.md
  entity_type: how-to-guide
---
# AGENTS.md

Guidance for coding agents working in this repository: an Obsidian plugin
that implements the MIF (Modeled Information Format) specification,
[mif-spec.dev](https://mif-spec.dev). User-facing documentation is in
[docs/](docs/README.md); the layout table in [README.md](README.md) maps the
tree.

## Architecture

- `src/engine/` is the MIF engine: pure TypeScript with no Obsidian import,
  so it runs under Vitest and can be swapped for a mif-rs WebAssembly build
  behind the same surface (see `docs/adr/0001-engine-implementation.md`).
  Anything that needs the app, the vault, or the DOM lives in `src/*.ts`.
- `src/manager.ts` owns the vault model: bundles, per-file analysis, the
  relationship index, and every write to a note.
- Writes are format-preserving. Edit frontmatter through the writer
  (`updateFrontmatter`, `setScalarIn`, `editStructure`) or `applyEdit`,
  never by re-serializing YAML, so untouched lines keep their exact text.
- Markdown is canonical and JSON-LD is derived. Frontmatter
  `relationships[]` is authoritative and the body's `## Relationships`
  section mirrors it: change both through `addRelationship`,
  `updateRelationship`, `removeRelationship`, or `syncMirror`.
- Path targets are written through `linkTarget` / `relativeTarget`, which
  percent-encode space, parentheses, angle brackets, and `%`;
  `resolveTarget` decodes them.
- Quick fixes are `Fix` objects with path-level `edits`, `updates`, or a
  `transform`; `applyTextFix` applies the text ones, and `VAULT_TRANSFORMS`
  lists those the manager performs against the vault.
- `src/engine/generated/` is built by `npm run validators` from `schemas/`.
  It is gitignored; never edit it by hand.

## Commands

Node 22+. Every script that needs the generated validators builds them
first.

```bash
npm ci && npm run lint:install   # dependencies, and the isolated ESLint
npm run lint                     # ESLint with Obsidian's review rules
npm run typecheck                # tsc --noEmit
npm test                         # Vitest, including goldens from MIF's reference scripts
npx vitest run tests/<file>      # one test file
npm run build                    # main.js
npm run check:mobile             # main.js loads without Node or Electron
npm run check:docs               # reference docs match the source
npm run install-vault            # copy the build into test-vault for manual testing
```

Before calling a change done, run lint, typecheck, the full test suite,
build, `check:mobile`, and `check:docs`, and report their actual results.
Do not report "lint clean" without running `npm run lint`.

- ESLint lives in `tools/lint/` with its own TypeScript 5, because the
  build uses TypeScript 7, which has no JavaScript API for ESLint to load.
- The parity oracle compares the engine with mif-rs compiled to
  WebAssembly; it runs only after `(cd spikes/mif-wasm && wasm-pack build
  --release --target nodejs --out-dir pkg-node)`. A difference must be
  listed in `KNOWN_GAPS` in `tests/wasm-parity.test.ts` with the spec gap
  that explains it.
- Scripts that read other repositories take their paths from the
  environment: `MIF_REPO` (`mif-align`, `sync-schemas`, `golden`), plus
  `ONTOLOGIES_REPO` and `MNEMONIC_REPO` for `golden`, and `MIF_CLI` for
  `tests/live-mif-cli.test.ts`. Never hard-code a local path.

## Keeping the docs true

- `npm run check:docs` fails when a diagnostic code, command name, or
  settings key exists in the source but not in `docs/reference/`, or the
  other way round. Adding any of these means documenting it in the same
  change.
- Docs follow Diátaxis: tutorial, how-to, reference, explanation.
- Every doc, including `README.md`, `SECURITY.md`, and this file, is a MIF
  record typed by the `mif-docs` ontology (`entity_type` how-to-guide,
  tutorial, reference-document, explanation, or decision-record). Write a
  new doc with the matching mif-docs genre skill; keep its `id` when you
  edit it, update `modified`, and keep the `## Relationships` section in step
  with its frontmatter. How-tos and the tutorial stop at Level 2; reference,
  explanation, and the ADR carry provenance and reach Level 3.
- Validate a changed doc with the mif-docs validator,
  `mif-validate <file> --level 2|3`, and in Obsidian with this plugin.
- Code comments describe the code. They do not mention development phases,
  plans, or where in a local workspace a file came from.

## Obsidian behaviors that have bitten this code

- `createSvg` does not split a `cls` string: pass an array of classes.
- Never name an `ItemView` field `scope` or `open`; Obsidian's base class
  already uses those names.
- `MarkdownPostProcessorContext.getSectionInfo` returns null until the
  section is attached to the document; defer the work.
- Open notes from sidebar views with `workspace.openLinkText`.
- Status bar items are flex containers: space them with CSS `gap`. Mobile
  has no status bar.
- Node built-ins are reached only through `window.require(...)` inside
  desktop-gated code (the mif-cli bridge). `check:mobile` enforces this.
- Delete through `app.fileManager.trashFile`, and build config paths from
  `vault.configDir`, never `.obsidian`.

## Git

- Work on a branch, then merge it into `main` locally. Do not push, tag,
  release, or open pull requests or issues unless the owner asks.
- Check `git status` and the staged file list before every commit. Commit
  only product content: code, tests, and user-facing docs. Never commit
  planning notes, findings, spike reports, alignment notes, or other
  working records, and ask before adding any new non-code document.
- Pin every GitHub Action to a full commit SHA, and verify the SHA exists
  before writing it.

## Relationships

- relates-to [Documentation](docs/README.md)
- relates-to [MIF for Obsidian](README.md)
