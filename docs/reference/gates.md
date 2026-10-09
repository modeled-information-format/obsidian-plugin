---
id: 4d5ee6fc-c46f-59d5-8abd-a81495163371
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _semantic/reference
title: Quality gates and workflows
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
  trustLevel: high_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source; command, setting, and diagnostic names are checked against the source by scripts/check-docs.mjs
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "MIF: Modeled Information Format specification"
  url: https://mif-spec.dev/
  accessed: 2026-10-09
- "@type": Citation
  citationType: specification
  citationRole: methodology
  title: "Diátaxis: Reference"
  url: https://diataxis.fr/reference/
  accessed: 2026-10-09
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Quality gates and workflows
  entity_type: reference-document
description: Reference listing for every workflow this template ships — triggers, jobs, gate verdicts, predicate types, and attestation subjects.
diataxis_type: reference
---

# Quality gates and workflows

This page lists every workflow in `.github/workflows/` exactly as shipped.
Predicate types, job names, and signing identities are normative.

---

## `ci.yml` — Continuous integration

Trigger: every push and pull request to `main`; `workflow_dispatch`.

| Job | Purpose |
|---|---|
| `pin-check` | Thin caller of `pin-check.yml`; fails closed if any `uses:` references an action by tag or branch instead of a full 40-char SHA |
| `lint` | Counts TODO/FIXME/HACK/XXX markers in YAML, shell, and Markdown (informational; never fails) |
| `validate-workflows` | Thin caller of `reusable-actionlint.yml`; validates workflow YAML syntax |

---

## `quality-gates.yml` — Merge-time gates

Trigger: push and pull request to `main`; weekly schedule (`37 6 * * 1`); `workflow_dispatch`.

Each job is a thin caller of the corresponding central reusable, pinned by the `.github` repo's commit SHA. All gates normalize on SARIF and surface in the repository Security tab.

| Job | Central reusable | Gate type | SARIF upload |
|---|---|---|---|
| `sast` | `reusable-sast-codeql.yml` | SAST (CodeQL), `languages: actions` | yes |
| `sca` | `reusable-sca-osv.yml` | SCA (OSV-Scanner); fails on severity `high` or above | yes |
| `posture` | `reusable-scorecard.yml` | OpenSSF Scorecard posture; push/schedule only | yes |
| `trivy` | `reusable-trivy.yml` | IaC/license (Trivy filesystem scan) | yes |

`posture` is a repo-level signal; it does not produce an artifact-bound attestation.

---

## `release.yml` — Attested release pipeline

Trigger: tag push matching `v*.*.*`; `workflow_dispatch` (dry-run — `publish` is tag-gated).

The invariant: `build → attest-provenance → generate+attest-SBOM → fail-closed-verify → [tag-gated] publish`.

| Job | Depends on | Key permissions | What it produces |
|---|---|---|---|
| `meta` | — | `contents: read` | Artifact name and version outputs |
| `build` | `meta` | `id-token: write`, `attestations: write` | Tarball in `dist/`; SLSA build provenance attestation; subject digest output |
| `sbom` | `meta`, `build` | `id-token: write`, `attestations: write` | CycloneDX SBOM (Syft via `anchore/sbom-action`); SBOM attestation bound to `dist/*` |
| `gate-sast` | `meta` | `security-events: write` | CodeQL SARIF for `languages: actions` |
| `attest-sast` | `meta`, `build`, `gate-sast` | `attestations: write` | Seam-signed attestation, predicate `sast/v1`, bound to subject digest |
| `gate-sca` | `meta` | `security-events: write` | OSV-Scanner SARIF |
| `attest-sca` | `meta`, `build`, `gate-sca` | `attestations: write` | Seam-signed attestation, predicate `sca/v1`, bound to subject digest |
| `gate-trivy` | `meta` | `security-events: write` | Trivy IaC/license SARIF |
| `attest-iac-license` | `meta`, `build`, `gate-trivy` | `attestations: write` | Seam-signed attestation, predicate `iac-license/v1`, bound to subject digest |
| `vex` | `meta`, `build` | `id-token: write`, `attestations: write` | OpenVEX disposition, self-signed by `reusable-vex.yml`, predicate `openvex.dev/ns/v0.2.0`, bound to subject digest |
| `verify` | `meta`, `build`, `sbom`, `attest-sast`, `attest-sca`, `attest-iac-license`, `vex` | `attestations: read` | Fail-closed `gh attestation verify` for all six predicates; job failure blocks `publish` |
| `publish` | `meta`, `verify` (tag-gated) | `contents: write` | GitHub Release with checksums; skipped on `workflow_dispatch` |

### Predicate types produced by `release.yml`

| Predicate | Signing identity | URI |
|---|---|---|
| SLSA build provenance | This repo's `release.yml` | `https://slsa.dev/provenance/v1` |
| CycloneDX SBOM | This repo's `release.yml` | `https://cyclonedx.org/bom` |
| SAST verdict | `reusable-attest-scan.yml` (seam) | `https://modeled-information-format.github.io/attestations/sast/v1` |
| SCA verdict | `reusable-attest-scan.yml` (seam) | `https://modeled-information-format.github.io/attestations/sca/v1` |
| IaC/license verdict | `reusable-attest-scan.yml` (seam) | `https://modeled-information-format.github.io/attestations/iac-license/v1` |
| VEX disposition | `reusable-vex.yml` (self-signed) | `https://openvex.dev/ns/v0.2.0` |

`verify` checks all six predicates before `publish` is allowed to execute.

---

## `dast.yml` — Attested DAST

Trigger: `workflow_dispatch` only. Requires a running target URL (`target` input; defaults to `https://modeled-information-format.github.io`).

| Job | Depends on | What it produces |
|---|---|---|
| `meta` | — | Name and version outputs |
| `subject` | `meta` | Source snapshot tarball; SLSA build provenance attestation; subject digest output |
| `gate-dast` | `meta` | ZAP JSON report via `reusable-zap.yml` (`fail-action: false` — verdict signed regardless of findings) |
| `attest-dast` | `meta`, `subject`, `gate-dast` | Seam-signed attestation, predicate `dast/v1`, bound to subject digest |
| `verify` | `meta`, `subject`, `attest-dast` | Fail-closed verify of provenance + `dast/v1`; workflow halts on failure |

Predicate: `https://modeled-information-format.github.io/attestations/dast/v1` (seam-signed).

Requires `zaproxy/action-full-scan@*` (or its pinned SHA) on the org Actions allow-list.

---

## Verification commands

See `SECURITY.md` for the full consumer verification guide. The commands below apply to seam-signed predicates (SLSA L3 — signer is the central reusable, not the caller repo):

```bash
# Seam-signed gate verdicts (sast, sca, iac-license, dast)
gh attestation verify "$ARTIFACT" \
  --owner modeled-information-format \
  --signer-workflow modeled-information-format/.github/.github/workflows/reusable-attest-scan.yml \
  --predicate-type "https://modeled-information-format.github.io/attestations/<gate>/v1"

# VEX (self-signed by reusable-vex.yml)
gh attestation verify "$ARTIFACT" \
  --owner modeled-information-format \
  --signer-workflow modeled-information-format/.github/.github/workflows/reusable-vex.yml \
  --predicate-type "https://openvex.dev/ns/v0.2.0"

# Provenance and SBOM (signed by this repo's release.yml)
gh attestation verify "$ARTIFACT" \
  --repo modeled-information-format/attested-pipeline-template \
  --predicate-type "https://slsa.dev/provenance/v1"

gh attestation verify "$ARTIFACT" \
  --repo modeled-information-format/attested-pipeline-template \
  --predicate-type "https://cyclonedx.org/bom"
```
