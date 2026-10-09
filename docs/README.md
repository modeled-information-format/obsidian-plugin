---
id: 7293619c-c184-5265-af9f-043fd575672f
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _semantic/reference
title: Documentation
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
  sourceRef: Written by an AI agent from the plugin source; command, setting, and diagnostic names are checked against the source by scripts/check-docs.mjs
relationships:
- type: relates-to
  target: tutorial/getting-started.md
- type: relates-to
  target: how-to/fix-problems.md
- type: relates-to
  target: how-to/relationships.md
- type: relates-to
  target: how-to/ontologies-and-entities.md
- type: relates-to
  target: how-to/freshness.md
- type: relates-to
  target: how-to/citations-and-compression.md
- type: relates-to
  target: how-to/export-and-query.md
- type: relates-to
  target: how-to/semantic-search.md
- type: relates-to
  target: how-to/migrate-from-0-1.md
- type: relates-to
  target: how-to/instantiate-with-copier.md
- type: relates-to
  target: reference/commands.md
- type: relates-to
  target: reference/settings.md
- type: relates-to
  target: reference/diagnostics.md
- type: relates-to
  target: reference/api.md
- type: relates-to
  target: reference/gates.md
- type: relates-to
  target: explanation/how-the-plugin-reads-mif.md
- type: relates-to
  target: explanation/attested-pipeline.md
- type: relates-to
  target: adr/0001-engine-implementation.md
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
  name: Documentation
  entity_type: reference-document
description: Index of the MIF for Obsidian documentation, organised by Diátaxis type, plus the project's own records.
diataxis_type: reference
---

# MIF for Obsidian — documentation

These pages are the canonical documentation; the project site publishes
them as they are.

## Tutorial

- [Getting started](tutorial/getting-started.md) — first concept,
  relationships, Level 3, JSON-LD

## How-to guides

- [Fix what the diagnostics report](how-to/fix-problems.md)
- [Work with relationships](how-to/relationships.md)
- [Use ontologies, namespaces, and entities](how-to/ontologies-and-entities.md)
- [Track freshness and validity](how-to/freshness.md)
- [Cite sources and compress long concepts](how-to/citations-and-compression.md)
- [Export JSON-LD and query MIF data](how-to/export-and-query.md)
- [Search concepts by meaning with mif-cli](how-to/semantic-search.md)
- [Migrate MIF 0.1 notes](how-to/migrate-from-0-1.md)
- [Instantiate or update the release pipeline with Copier](how-to/instantiate-with-copier.md) (maintainers)

## Reference

- [Commands](reference/commands.md)
- [Settings](reference/settings.md)
- [Diagnostic codes](reference/diagnostics.md)
- [Plugin API](reference/api.md)
- [Quality gates and workflows](reference/gates.md) (maintainers)

## Explanation

- [How the plugin reads MIF](explanation/how-the-plugin-reads-mif.md)
- [The attested release pipeline](explanation/attested-pipeline.md) (maintainers)

## Decisions

- [ADR-0001: engine implementation](adr/0001-engine-implementation.md)

## Relationships

- relates-to [Getting started with MIF in Obsidian](tutorial/getting-started.md)
- relates-to [Fix what the diagnostics report](how-to/fix-problems.md)
- relates-to [Work with relationships](how-to/relationships.md)
- relates-to [Use ontologies, namespaces, and entities](how-to/ontologies-and-entities.md)
- relates-to [Track freshness and validity](how-to/freshness.md)
- relates-to [Cite sources and compress long concepts](how-to/citations-and-compression.md)
- relates-to [Export JSON-LD and query MIF data](how-to/export-and-query.md)
- relates-to [Search concepts by meaning with mif-cli](how-to/semantic-search.md)
- relates-to [Migrate MIF 0.1 notes](how-to/migrate-from-0-1.md)
- relates-to [Instantiate this template with Copier](how-to/instantiate-with-copier.md)
- relates-to [Commands](reference/commands.md)
- relates-to [Settings](reference/settings.md)
- relates-to [Diagnostic codes](reference/diagnostics.md)
- relates-to [Plugin API](reference/api.md)
- relates-to [Quality gates and workflows](reference/gates.md)
- relates-to [How the plugin reads MIF](explanation/how-the-plugin-reads-mif.md)
- relates-to [The attested pipeline model](explanation/attested-pipeline.md)
- relates-to [ADR-0001: MIF engine implementation for the Obsidian plugin](adr/0001-engine-implementation.md)
