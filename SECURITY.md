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
  each against the sha256 in the published catalog before use. Nothing about
  your vault is sent.
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
