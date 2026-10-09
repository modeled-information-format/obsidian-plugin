---
id: dec34fb4-0bc5-42bf-be4e-208045dc26d2
type: semantic
created: 2026-10-07T18:38:46Z
modified: 2026-10-07T23:48:04Z
namespace: _semantic/decisions
title: "ADR-0001: MIF engine implementation for the Obsidian plugin"
summary: The plugin implements MIF parsing, projection, round-trip, and validation in TypeScript, held to the reference converter by tests and cross-checked against mif-rs, rather than embedding mif-rs as WebAssembly.
tags:
- adr
- engine
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-07T18:38:46Z
  recordedAt: 2026-10-07T18:38:46Z
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin's engine design and its test suites
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: "ADR-0001: MIF engine implementation for the Obsidian plugin"
  entity_type: decision-record
---

# ADR-0001: MIF engine implementation

## Status

Accepted, 2026-10-07.

## Context

The plugin needs a MIF engine that reads a concept's frontmatter, projects it
to JSON-LD, proves the round trip is lossless, and validates the result
against the canonical schemas. It must run on Obsidian desktop and mobile,
offline, and ship inside the single `main.js` file Obsidian allows a
community plugin.

Two implementations already exist: the reference converter `mif_convert.py`
(named by spec Invariant 4) and the Rust library mif-rs (behind the `mif` CLI
and MCP server). They do not agree:

- They read YAML differently: version 1.1 versus 1.2 rules.
- They pass different frontmatter keys through to JSON-LD.
- mif-rs validates against an outdated schema and does not enforce `format`
  rules such as `date-time`, while MIF's own CI does.

Obsidian itself reads frontmatter as YAML 1.2, agreeing with mif-rs. The spec
does not yet say which behaviour is normative.

## Decision drivers

1. Agree with what MIF's conformance tooling accepts and rejects today.
2. Keep the plugin small enough to load quickly on mobile.
3. Avoid a second implementation drifting silently from mif-rs.
4. Be able to adopt the spec's eventual YAML version without a rewrite.

## Options considered

| | A. mif-rs as WebAssembly | B. TypeScript engine | C. mif-rs parsing + TypeScript validation |
|---|---|---|---|
| Added plugin size | ≈ 2.8 MB | none (whole plugin ≈ 280 KB) | ≈ 350 KB |
| Matches the reference converter | No (YAML 1.2) | Yes | No (YAML 1.2) |
| Matches MIF CI's schema validation | No | Yes | Yes |
| Same behaviour as `mif` CLI and MCP | Yes | Where tests pin it | Parsing only |
| Implementations to maintain | One | Two | One and a half |

Speed did not separate the options: every operation takes well under a
millisecond either way.

## Decision

**Option B.** The plugin uses its own TypeScript engine:

- It matches the reference converter's reading of YAML, enforced by golden
  tests generated from `mif_convert.py`.
- It passes every frontmatter key through to JSON-LD, as mif-rs does,
  because dropping user properties is not acceptable in Obsidian.
- It validates with the same validator and format rules as MIF's CI.

mif-rs is kept as a **parity oracle**: CI builds its parsing layer as
WebAssembly and fails on any difference from the TypeScript engine that is
not a recorded spec gap.

## Consequences

- **Positive:** the plugin agrees with MIF's conformance tooling today, adds
  no size, and has no runtime code-generation or WebAssembly loading on
  mobile.
- **Negative:** two implementations of MIF parsing exist. The parity oracle
  makes drift visible, but each spec change has to be made in both.
- **Tension with Obsidian:** until the YAML version is settled, the plugin reads some
  values (`yes`, `010`, unquoted timestamps) differently from Obsidian's
  Properties panel. The plugin flags these values rather than hiding the
  difference.
- **Revisit trigger:** if the spec adopts YAML 1.2 with verbatim timestamps
  (the direction mif-rs and Obsidian already take), move parsing to mif-rs
  (option C) and retire the TypeScript YAML layer.

## Follow-ups

- Propose YAML 1.2 upstream.
- Update mif-rs's embedded schema and format checks so the CLI and MCP server validate like MIF's CI.
- Generate schema validators at build time instead of at runtime.
