---
id: ebcf822a-e84d-5071-9044-535129a1b97e
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _semantic/reference
title: Security Policy
tags:
- reference
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the repository's release workflows
relationships:
- type: relates-to
  target: docs/explanation/attested-pipeline.md
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "MIF: Modeled Information Format specification"
  url: https://mif-spec.dev/
  accessed: 2026-10-09
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Security Policy
  entity_type: reference-document
---
# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.
Use [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
for this repository, or email the maintainer. We respond within 72 hours and
coordinate a fix and disclosure timeline.

## What the plugin can touch

- **Files:** only notes in the bundles you configure (and their `.mif/`
  folders), the JSON-LD export folder, and its own plugin folder. Note edits
  go through Obsidian's `Vault.process` and are read back; entity files in
  `.mif/entities/`, the ontology cache, and the developer log are written
  through the vault adapter; the 0.1 → 1.0 migration renames `.memory.md`
  files; developer commands (off by default) write reports under `_spike/`.
  Nothing in your vault is deleted except stale JSON-LD exports, which go to
  the trash (respecting your deletion setting); the clear-cache button
  beside the ontology download setting removes the plugin's own
  downloaded-ontology folder.
- **Network:** only when **Download ontologies from mif-spec.dev** is on: it
  fetches ontology files from `https://mif-spec.dev/ontologies/` and checks
  each against the sha256 in the published catalog before use, and fetches
  the catalog once when the MCP server starts. Nothing about your vault is
  sent.
- **A local port (desktop only):** only when you turn **MCP server** on for
  a vault. The plugin then listens on `127.0.0.1` at that vault's port, and
  nowhere else: it is not reachable from another computer. Every request
  must carry the vault's token (256 bits, generated on your machine, stored
  in the plugin's settings file, compared in constant time), and a request
  whose `Host` or `Origin` is not this computer is refused before the token
  is looked at, which stops a web page from reaching it through your
  browser. A program running as you on this computer that can read the
  vault's files can also read the token; the server is not a boundary
  against it. An MCP client you connect reads what you ask it to read, and
  what it then sends to its model provider is outside this plugin.
- **Writes by an MCP client:** only when you also turn **Allow MCP writes**
  on. They go through the same path as the plugin's own writes, never into a
  note you are editing, and are limited to 30 in 10 minutes unless you
  change that. A concept a client writes or edits is marked unverified with
  the client's self-reported name until you review it; each write shows a
  notice and is appended to `mcp-audit.log` in the plugin's folder.
  Replacing a concept, and changing or removing a relationship, ask you
  first when the client can show a question.
- **Code written to disk (desktop only):** the first time the MCP server
  starts, the plugin writes `mcp.cjs` into its own folder and loads it. That
  file is the server's code, carried compressed inside `main.js` and checked
  against a sha256 recorded there before it is written; a copy on disk that
  differs is replaced. Nothing is downloaded for this.
- **Local programs (desktop only):** only when you set a `mif-cli` path. The
  plugin runs that binary with an argument list (never through a shell). On
  first ingest `mif-cli` downloads its embedding model from Hugging Face.
- No telemetry, no accounts, no remote code.

## Verifying a release

Releases are built by `.github/workflows/release.yml` and published only after
every attestation verifies (fail-closed). With [GitHub CLI](https://cli.github.com/)
≥ 2.49 (`gh auth login`):

**The plugin files** (`main.js`, `manifest.json`, `styles.css`): SLSA build
provenance and a CycloneDX SBOM, signed by this repository's workflow.

```bash
for f in main.js manifest.json styles.css; do
  gh attestation verify "$f" --repo modeled-information-format/obsidian-plugin \
    --predicate-type https://slsa.dev/provenance/v1
  gh attestation verify "$f" --repo modeled-information-format/obsidian-plugin \
    --predicate-type https://cyclonedx.org/bom
done
```

**The source snapshot** (`obsidian-plugin-<version>-source.tar.gz`, a release
asset): provenance, plus the SAST (CodeQL), SCA (OSV), and IaC/license
(Trivy) verdicts and the OpenVEX disposition. The verdicts are signed by the
org's central attestation workflows, so verification names the signer:

```bash
SRC=obsidian-plugin-<version>-source.tar.gz
gh attestation verify "$SRC" --repo modeled-information-format/obsidian-plugin \
  --predicate-type https://slsa.dev/provenance/v1
for PT in sast sca iac-license; do
  gh attestation verify "$SRC" --owner modeled-information-format \
    --signer-workflow modeled-information-format/.github/.github/workflows/reusable-attest-scan.yml \
    --predicate-type "https://modeled-information-format.github.io/attestations/${PT}/v1"
done
gh attestation verify "$SRC" --owner modeled-information-format \
  --signer-workflow modeled-information-format/.github/.github/workflows/reusable-vex.yml \
  --predicate-type https://openvex.dev/ns/v0.2.0
```

A passing verification proves the artifact was built by this repository from
a recorded commit, and that each gate ran and recorded a verdict bound to the
source digest; read the predicate for the verdict itself (signed ≠ passed).
Treat any failure as a supply-chain integrity breach and do not install the
release.

## Supply-chain posture

- Every GitHub Action is pinned to a full 40-character commit SHA; `ci.yml`'s
  `pin-check` enforces it.
- CI runs lint (Obsidian's review rules), typecheck, the test suite (golden
  parity with MIF's reference scripts), the build, a mobile load check, and a
  parity oracle against mif-rs compiled to WASM.
- `quality-gates.yml` runs CodeQL (workflows and TypeScript), OSV (both npm
  lockfiles), Trivy, and Scorecard on every push and weekly.
- Tools are installed from lockfiles (`npm ci`) or pinned versions
  (`cargo install --locked --version`), never piped to a shell. The pipeline
  comes from [mif-repo-template](https://github.com/modeled-information-format/mif-repo-template); see
  [docs/explanation/attested-pipeline.md](docs/explanation/attested-pipeline.md).

## Relationships

- relates-to [The attested pipeline model](docs/explanation/attested-pipeline.md)
