---
id: 4d5ee6fc-c46f-59d5-8abd-a81495163371
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-09T11:29:16Z
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
relationships:
- type: relates-to
  target: ../../SECURITY.md
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
description: Reference for this repository's workflows, their triggers, jobs, gates, attestation predicates, and signers.
diataxis_type: reference
---

# Quality gates and workflows

The workflows in `.github/workflows/`, as they are in this repository.
Predicate types, job names, and signing identities are normative.

---

## `ci.yml`: continuous integration

Trigger: push and pull request to `main`; `workflow_dispatch`.

| Job | What it does |
|---|---|
| `pin-check` | Calls `pin-check.yml`; fails if any `uses:` names an action by tag or branch instead of a full commit SHA |
| `validate-workflows` | Calls `reusable-actionlint.yml`; validates the workflow files |
| `plugin` | Installs dependencies, then runs `lint`, `typecheck`, `test`, `build`, `check:mobile`, and `check:docs` |
| `parity` | Builds mif-rs as WebAssembly from a pinned commit and compares it with the plugin's engine over every fixture |

---

## `quality-gates.yml`: merge-time gates

Trigger: push and pull request to `main`; weekly schedule (`37 6 * * 1`);
`workflow_dispatch`.

Each job calls the matching reusable workflow in the organization's `.github`
repository, pinned by commit SHA, and reports SARIF to GitHub code scanning.

| Job | Reusable workflow | Gate |
|---|---|---|
| `sast` | `reusable-sast-codeql.yml` | CodeQL, languages `actions` and `javascript-typescript` |
| `sca` | `reusable-sca-osv.yml` | OSV-Scanner over `package-lock.json` and `tools/lint/package-lock.json`; fails at severity `high` |
| `posture` | `reusable-scorecard.yml` | OpenSSF Scorecard; push and schedule only |
| `trivy` | `reusable-trivy.yml` | Trivy IaC and license scan |

Code scanning needs GitHub Advanced Security on a private repository, so every
gate job is skipped while the repository is private
(`if: !github.event.repository.private`) and runs once it is public.

---

## `release.yml`: attested release

Trigger: a tag that is a bare version (`1.2.3` or `1.2.3-beta.1`, no `v`), as
Obsidian requires; `workflow_dispatch` for a dry run that builds, tests, and
scans but signs and publishes nothing.

| Job | Needs | What it produces |
|---|---|---|
| `meta` | | Version; refuses a tag that disagrees with `manifest.json` or `versions.json` |
| `test` | | `lint`, `typecheck`, and `test` |
| `build` | `meta`, `test` | `main.js`, `manifest.json`, `styles.css`, each with SLSA build provenance |
| `source` | `meta` | A source snapshot tarball with SLSA build provenance; the subject of the gate verdicts |
| `sbom` | `meta`, `build` | A CycloneDX SBOM, attested on each of the three plugin files |
| `gate-sast`, `gate-sca`, `gate-trivy` | `meta` | CodeQL, OSV-Scanner, and Trivy scans, as in `quality-gates.yml` |
| `attest-sast`, `attest-sca`, `attest-iac-license` | `meta`, `source`, the gate | A verdict attestation on the source snapshot, signed by the organization's `reusable-attest-scan.yml`; tags only |
| `vex` | `meta`, `source` | An OpenVEX disposition on the source snapshot, signed by `reusable-vex.yml`; tags only |
| `verify` | all of the above | Fails closed unless every attestation below verifies; tags only |
| `release` | `meta`, `verify` | The GitHub Release with the three plugin files; tags only |

The release gates also report to code scanning, so a tagged release cannot
pass while the repository is private without Advanced Security.

### Attestations

| Subject | Predicate | Signer |
|---|---|---|
| `main.js`, `manifest.json`, `styles.css` | `https://slsa.dev/provenance/v1` | This repository's `release.yml` |
| `main.js`, `manifest.json`, `styles.css` | `https://cyclonedx.org/bom` | This repository's `release.yml` |
| Source snapshot | `https://slsa.dev/provenance/v1` | This repository's `release.yml` |
| Source snapshot | `https://modeled-information-format.github.io/attestations/sast/v1` | `reusable-attest-scan.yml` |
| Source snapshot | `https://modeled-information-format.github.io/attestations/sca/v1` | `reusable-attest-scan.yml` |
| Source snapshot | `https://modeled-information-format.github.io/attestations/iac-license/v1` | `reusable-attest-scan.yml` |
| Source snapshot | `https://openvex.dev/ns/v0.2.0` | `reusable-vex.yml` |

[SECURITY.md](../../SECURITY.md) has the commands to verify a release.

## Relationships

- relates-to [Security Policy](../../SECURITY.md)
