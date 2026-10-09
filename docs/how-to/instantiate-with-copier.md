---
id: 9e4df4ce-4d74-542c-89b4-dc7f97ffe1bf
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _procedural/learning
title: Instantiate this template with Copier
tags:
- how-to
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Instantiate this template with Copier
  entity_type: how-to-guide
description: How to stand up a new project from attested-pipeline-template using Copier and pull future template improvements.
diataxis_type: how-to
---

# Instantiate this template with Copier

attested-pipeline-template is a **living, update-propagating template**. You can
stand up a project three ways; they differ in one decisive way — whether you can
later pull template improvements with `copier update`.

| Path | Gets the files | `copier update` later? |
| --- | --- | --- |
| `copier copy` (recommended) | yes | **yes** — records `.copier-answers.yml` |
| GitHub "Use this template" | yes | no (until you adopt Copier) |
| `git clone` | yes | no |

## Option A — Copier (recommended)

```bash
uvx copier copy gh:modeled-information-format/attested-pipeline-template my-project
# or: pipx install copier && copier copy gh:modeled-information-format/attested-pipeline-template my-project
cd my-project
```

Copier asks for the project name, owner, and description; writes a
`.copier-answers.yml` recording your answers and the template version; and
renders the per-instance record at `docs/instance.md`. Only `*.jinja` files are
rendered (suffix dropped); every other file — the attested pipeline workflows,
the VEX disposition, and the gates — is copied verbatim. `copier.yml` is
excluded from instances.

Finish by updating the self-references in `README.md`, `SECURITY.md`, and the
workflows (see `docs/instance.md`).

## Pull later template improvements

This is the differentiator over snapshot engines. When the template ships a fix
or addition, re-apply it to your project:

```bash
cd my-project
copier update   # re-applies template changes, preserving your answers
```

## Option B — GitHub "Use this template"

Still fully supported. This path does not record Copier answers, so
`copier update` will not work until you adopt Copier (run `copier copy` over the
repo and commit the resulting `.copier-answers.yml`).
