---
diataxis_type: how-to
title: Instantiate this template with Copier
description: How to stand up a new project from attested-pipeline-template using Copier and pull future template improvements.
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
