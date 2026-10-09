---
id: 655d8ae7-596f-508d-9419-4153042b4db3
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:18:08Z
namespace: _semantic/architecture
title: How the plugin reads MIF
tags:
- explanation
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
  sourceRef: Written by an AI agent from the plugin source and the MIF specification
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
  title: "Diátaxis: Explanation"
  url: https://diataxis.fr/explanation/
  accessed: 2026-10-09
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: How the plugin reads MIF
  entity_type: explanation
description: Why markdown stays canonical, how levels are decided, why some checks are advisory, and where the plugin interprets an open spec.
diataxis_type: explanation
---

# How the plugin reads MIF

## Markdown is the source; everything else is derived

MIF keeps a concept as a markdown file with YAML frontmatter; the JSON-LD
form is a projection of it (Invariant 2). The plugin never stores JSON-LD
beside a note: it shows it live, and exports it on request into a separate
folder. Every edit is made to the markdown, and the round trip to JSON-LD and
back must lose nothing (Invariant 4) — the JSON-LD panel and the round-trip
command check that.

## Edits touch only what they change

Obsidian's own frontmatter API rewrites values, reorders keys, and drops
empty blocks. The plugin never uses it: it edits the YAML text itself, one
value or one line at a time, and reads every write back. A fix that would
change anything else is refused.

## Frontmatter is authoritative; the body mirrors it

Relationships are defined in frontmatter `relationships[]` and mirrored in
`## Relationships` as markdown links, so tools that only read markdown — and
Obsidian's backlinks and graph — still see them (Invariant 3). Citations work
the same way with an optional `## Citations` section. When the two disagree,
frontmatter wins.

## Levels follow the tooling

A concept's level (shown as `MIF L1`–`L3`) is decided the way MIF's own
validators decide it: Level 1 if the JSON-LD passes the canonical schema,
Level 2 with `namespace`, `modified`, and `temporal`, Level 3 with
`provenance` and `temporal.validFrom`. The spec's §13 lists features rather
than fields, so the plugin follows the tools.

## Why some checks are advisory

No MIF tool enforces ontologies, namespaces, traits, or entity files, and the
spec leaves parts of them open. The plugin checks them, but as warnings and
info that never change a level. The same goes for provenance confidence
ranges and freshness bands, which the spec describes without making them
rules.

## Where the spec is open

Where the spec, the schemas, and the reference tools disagree, the plugin
follows the canonical schema for conformance and the reference tools for
behaviour, and says so in the diagnostic's message. It is tested against
MIF's reference scripts (golden files) and against mif-rs compiled to
WebAssembly (the parity oracle).
