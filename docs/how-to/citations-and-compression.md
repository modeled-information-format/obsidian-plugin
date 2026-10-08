---
diataxis_type: how-to
title: Cite sources and compress long concepts
description: Validate citations, keep a ## Citations section, record provenance, and compress a concept to its summary.
---

# Cite sources and compress long concepts

## Citations

Edit citations in the Properties panel under **Citations**. Each problem gets
one diagnostic with fixes that follow spec §5.4.7: an unknown type becomes
`other` (or the type it most likely meant, e.g. `blog` → `article`), an
unknown role `background`, a scheme-less URL gets `https://`, a date is
normalised to `YYYY-MM-DD`, relevance is clamped to 0–1.

**Authors as entities:** **Add author entity…** under a citation's author
picks or creates an entity.

## The `## Citations` section

An optional body section for annotations:

```markdown
## Citations

- [Memory Systems in AI Agents](https://arxiv.org/abs/2024.12345) by Jane Smith (2024)
  - **Type**: article
  - **Role**: supports
  - Your notes on the source.
```

- **Write or update it:** **MIF: Write or update the ## Citations section from
  frontmatter**, or the button under **Citations** in the Properties panel.
  Link lines and Type / Role / Relevance / Accessed items follow frontmatter;
  your annotations stay.
- **Body-only entries** (no frontmatter citation with that URL) are reported;
  **Add body-only citations to frontmatter** adopts them.
- In Sync mode an existing section is kept up to date.

## Provenance

Under **Provenance**, the source type and trust level dropdowns describe each
value. The diagnostics note a confidence outside the source type's usual
range, `user_stated` trust without a user source, and an empty `provenance`.
The bundle report filters by trust level.

## Compression

A concept with a `summary` can be compressed: the body becomes the summary,
the original text is kept in `extensions.original_content`, and the
`## Relationships` and `## Citations` sections stay.

- **Compress:** **MIF: Compress this concept to its summary**, or
  **Compress…** in the Properties panel. Long, old, or weak concepts get a
  `compression-candidate` suggestion.
- **Read it:** the Related panel and the top of reading view show
  *Compressed* with the original, expandable.
- **Undo:** **MIF: Restore original content of a compressed concept** brings
  back the exact original.
