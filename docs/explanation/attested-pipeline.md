---
diataxis_type: explanation
title: The attested pipeline model
description: Why attested-pipeline-template exists, what the build→attest→verify→publish model means, and how the pieces fit together.
---

# The attested pipeline model

This document explains what this template is and why it is structured the way it
is. For step-by-step usage see [How to instantiate with Copier](../how-to/instantiate-with-copier.md).
For the exact workflow and gate inventory see [Quality gates and workflows](../reference/gates.md).
For ecosystem concepts and the full attestation architecture see the
[modeled-information-format docs](https://modeled-information-format.github.io/docs/).

---

## What this template is

`attested-pipeline-template` is a language-agnostic GitHub repository template
that demonstrates the **attested release architecture**. It is a complete,
working pipeline — not a skeleton — that any team can copy, adapt the build step
for their toolchain, and have a production-grade attested release pipeline
running immediately.

The one adaptation point is the `Build artifact` step in `release.yml`. The
artifact can be a compiled binary, a tarball, a package archive, or any other
file that lands in `dist/`. Every other stage — attestation, verification,
publication — is toolchain-agnostic and is not meant to be modified.

---

## The central invariant

```
build → attest-provenance → generate+attest-SBOM → fail-closed-verify → publish
```

No step is optional. GitHub Actions enforces the dependency order through the
`needs:` graph. If `verify` fails, `publish` does not execute — there is no code
path from build to release that bypasses verification.

A tag publishes nothing unattested.

---

## Why fail-closed verification matters

Attesting an artifact and then shipping it without re-verifying the attestation
is not a security control — it is record-keeping. The property that actually
matters is that publication is **conditional on verification passing**.

The `verify` job in `release.yml` calls `gh attestation verify` for every
predicate type the pipeline produced: SLSA build provenance, CycloneDX SBOM, and
the three seam-signed gate verdicts (SAST, SCA, IaC/license). If any check
returns non-zero the job fails and `publish` — which declares `needs: [verify]`
— is never scheduled.

This is the distinction between an attested pipeline and a pipeline that happens
to call some attestation actions.

---

## What each gate attests

Each quality gate in the release pipeline runs against the source that will
ship and produces a verdict. The attestation seam (`reusable-attest-scan.yml`)
signs that verdict and binds it to the artifact's SHA-256 digest, producing an
in-toto attestation with a custom predicate type. The result is a
cryptographically verifiable claim: "gate X ran and recorded this verdict for
artifact with digest Y."

Signing ≠ passing. An attestation proves a gate ran and recorded a verdict.
Verification policy must read the predicate body to learn whether the gate
passed. The seam signs the SARIF regardless of finding count; a consumer who
wants "no high-severity findings" must check the verdict, not just confirm an
attestation exists.

---

## The seam and SLSA Build Level 3

Under SLSA Build L3, the signer identity is the **workflow that performed the
signing**, not the caller repository. In this template, gate verdicts are
signed by the central `reusable-attest-scan.yml` reusable, which the caller
workflow invokes but cannot modify. This isolation is what makes the claim
trustworthy: a compromised caller cannot forge a seam-signed verdict because the
signer is the reusable, not the caller.

As a consequence, verifying seam-signed predicates requires `--signer-workflow`
pointing at `reusable-attest-scan.yml`. Using `--repo` alone is insufficient
for these predicates.

SLSA build provenance and the SBOM are signed by this repository's own
`release.yml` (via `actions/attest-build-provenance` and `actions/attest-sbom`),
so those two predicates verify with `--repo`.

---

## The VEX disposition

The OpenVEX attestation (`vex` job) is a vulnerability disposition: it records
how this project's maintainers assess known CVEs against the shipped artifact.
Unlike the gate-verdict attestations, VEX is self-signed by `reusable-vex.yml`
(a different signer from the seam), so its verification command pins
`--signer-workflow reusable-vex.yml`, not `reusable-attest-scan.yml`.

The VEX document lives at `.vex/openvex.json` and is meant to be updated by the
project's maintainers whenever a CVE requires a disposition statement.

---

## Merge-time vs. release-time gates

The template ships two gate contexts:

- **`quality-gates.yml`** runs on every push and pull request to `main`. These
  gates (SAST, SCA, posture, IaC/license) protect the merge gate. Their SARIF
  output surfaces in the repository Security tab. Scorecard posture lives here
  because it is a repo-level signal, not an artifact verdict.

- **`release.yml`** re-runs SAST, SCA, and IaC/license against the exact source
  tree that is being packaged into the release artifact. Their verdicts are then
  seam-signed and bound to the artifact digest. This is deliberate duplication:
  merge-time gates keep the branch clean; release-time gates produce the
  attestations that travel with the artifact.

---

## DAST as a separate concern

Dynamic application security testing (`dast.yml`) is `workflow_dispatch`-only
because it requires a running target. The caller supplies a URL; the gate
(ZAP via `reusable-zap.yml`) scans it; the seam signs the verdict as `dast/v1`;
a fail-closed `verify` job re-checks it.

Adopters using this template for a web service should point `target` at their
deployed staging or preview environment. For artifacts that are not web services
(the default tarball build) DAST is not applicable.

---

## SHA-pinned actions

Every `uses:` in this template is pinned to a full 40-character commit SHA with
a trailing `# vX.Y.Z` comment. Tag references are mutable; a tag owner can move
a tag to a different commit at any time, silently changing what code runs in CI.
A SHA reference is immutable.

The `pin-check` job in `ci.yml` enforces this on every push and pull request.
Any `uses:` referencing a tag or branch name fails the check.

---

## Copier and update propagation

The template uses [Copier](https://copier.readthedocs.io/) to record the
instantiation context (project name, owner, description) in a
`.copier-answers.yml` file. When the template ships improvements — updated
action SHAs, new gate wiring, workflow fixes — adopters who instantiated via
`copier copy` can pull those changes with `copier update`. Adopters who used
GitHub's "Use this template" button received a snapshot and must re-adopt Copier
to benefit from update propagation.

For a deeper treatment of the attestation model and the org-wide toolchain this
template is part of, see the
[modeled-information-format docs](https://modeled-information-format.github.io/docs/).
