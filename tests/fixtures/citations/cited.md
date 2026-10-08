---
id: c0000000-0000-4000-8000-000000000001
type: semantic
created: 2026-01-10T00:00:00Z
title: Cited fact
citations:
  - '@type': Citation
    citationType: article
    citationRole: supports
    title: Memory Systems in AI Agents
    url: https://arxiv.org/abs/2024.12345
    author:
      '@type': EntityReference
      entity:
        '@id': urn:mif:entity:person:jane-smith
      entityType: person
      name: Jane Smith
    date: '2024-06-15'
    relevance: 0.95
  - '@type': Citation
    citationType: documentation
    citationRole: background
    title: JSON-LD 1.1
    url: https://www.w3.org/TR/json-ld11/
    accessed: '2026-01-18'
  - '@type': Citation
    citationType: specification
    citationRole: methodology
    title: RFC 3339
    url: https://www.rfc-editor.org/rfc/rfc3339
relationships:
  - type: relates-to
    target: uncited.md
---

# Cited fact

A fact with sources.

## Citations

- [Memory Systems in AI Agents](https://arxiv.org/abs/2024.12345) by Jane Smith (2024)
  - **Type**: article
  - **Role**: background
  - **Relevance**: 0.95
  - Foundational paper on semantic memory structures.

- [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) by W3C
  - **Type**: documentation
  - **Role**: background
  - Reference for the projection format.

- [CommonMark](https://spec.commonmark.org/)
  - **Type**: spec
  - **Relevance**: 0.5

## Relationships

- relates-to [Uncited](uncited.md)
