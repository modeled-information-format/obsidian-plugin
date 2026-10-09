---
id: ee631d51-96bf-5747-9235-6fb5ea59fd19
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:38:01Z
namespace: _semantic/reference
title: Diagnostic codes
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
  name: Diagnostic codes
  entity_type: reference-document
description: Every diagnostic the plugin reports, with its severity, meaning, and quick fixes.
diataxis_type: reference
---

# Diagnostic codes

Severity: **error** — the concept fails the MIF schema (Level 0) or cannot be
read; **warning** — a real problem that does not change the level;
**info** — advisory. `npm run check:docs` fails if this table and the source
disagree.

## Reading and identity

| Code | Severity | Meaning | Fixes |
|---|---|---|---|
| `crlf` | error | Windows line endings; MIF tools cannot read the frontmatter | Convert to LF |
| `yaml-invalid` | error | The frontmatter is not valid YAML | — |
| `yaml-ambiguous` | warning | A value reads differently in MIF (YAML 1.1) and Obsidian (YAML 1.2), e.g. `yes`, `010` | Keep either reading |
| `rewritten` | warning | Obsidian's Properties panel changed such a value | Restore, or keep the new value |
| `missing-id` | error | No `id` | Add a new UUID |
| `id-not-uuid` | error | `id` is not a UUID (the 1.4 schema requires `@id` = `urn:mif:<uuid>`) | Replace with a new UUID, keeping the old as an alias |
| `missing-type` | error | No `type` | Set semantic / episodic / procedural |
| `missing-created` | error | No `created` | Set to now |
| `projection` | error | The note cannot be projected to JSON-LD | — |
| `projection-conflict` | warning | Two keys project to the same JSON-LD property and one would be lost | — |
| `schema-<keyword>` | error | Any other schema failure (`<keyword>` is the JSON Schema keyword, e.g. `schema-format`) | — |
| `level-gap` | info | What the next conformance level needs | Add the missing fields |
| `legacy-0.1` | warning | A MIF 0.1 note | Migrate to MIF 1.0 |
| `internal` | error | The plugin could not analyse the note (please report it) | — |

## Relationships (bundle-wide)

| Code | Severity | Meaning | Fixes |
|---|---|---|---|
| `mirror-drift` | error | Frontmatter `relationships` and the `## Relationships` body section disagree | Regenerate the body; add body-only lines to frontmatter |
| `mirror-malformed` | error | A damaged line in `## Relationships` | Regenerate the body |
| `undeclared-type` | error | A namespaced relationship type the bundle's config does not declare | — |
| `relationship-metadata` | error | Relationship `metadata` does not match the type's declared properties | — |
| `broken-target` | warning | A `urn:mif:<uuid>` target that matches no concept in the bundle | — |
| `broken-link` | warning | A markdown link in the body — including a `## Relationships` line, so a missing path target — to a `.md` file that does not exist | — |
| `temporal-inconsistency` | warning | A `derived-from` / `supersedes` / `cites` target created after this concept | — |
| `superseded` | warning | Another concept supersedes this one | — |
| `conflict` | info | This concept conflicts with another | — |

## Ontology, namespace, entities (advisory)

| Code | Severity | Meaning | Fixes |
|---|---|---|---|
| `ontology-unknown` | warning | The declared ontology is not loaded | Download it from mif-spec.dev |
| `ontology-chain` | warning | The ontology's `extends` chain cannot be resolved | — |
| `ontology-version` | info | The declared version differs from the loaded definition | — |
| `namespace-reserved` | info | An underscore namespace root that is not a known reserved one | — |
| `namespace-type` | warning | `_semantic` / `_episodic` / `_procedural` root does not match `type` | Set the matching root |
| `namespace-shared` | info | A `_shared/<agreement>` with no agreement file | — |
| `namespace-undeclared` | info | The namespace is not declared by the concept's ontology chain | Use a declared namespace |
| `namespace-type-hint` | warning | The ontology marks the namespace for another concept type | — |
| `entity-type-unknown` | warning | The entity type is not defined by the ontology chain | — |
| `entity-type-base` | warning | The entity type belongs to another base type | Set `type` |
| `entity-fields` | warning | The entity lacks fields its type requires | — |
| `entity-type-no-ontology` | info | An entity type on a concept with no declared ontology | — |
| `trait-unresolved` | warning | A trait the ontology chain does not define | — |
| `trait-cycle` | warning | Traits include each other in a cycle | — |
| `trait-conflict` | warning | Two traits define the same field differently (§10.8.6) | — |
| `trait-requires` | info | The entity type's traits expect fields on the concept | — |
| `entity-urn` | info | An entity reference not in `urn:mif:entity:<type>:<slug>` form | — |
| `entity-unresolved` | info | No `.mif/entities` file for a referenced entity (also citation authors) | Create the entity file |
| `discovery-namespace` | info | The ontology's discovery rules suggest a namespace | Set it |
| `discovery-entity` | info | The ontology's discovery rules suggest an entity type | Mark it |

## Temporal and freshness

| Code | Severity | Meaning | Fixes |
|---|---|---|---|
| `freshness-expired` | warning | Past `validUntil`, or `ttl` elapsed since `recordedAt` | Extend `validUntil` by its own span; remove `validUntil`; renew or remove `ttl`; supersede with a new concept |
| `freshness-stale` | info | Decay strength below the ageing threshold | Mark reviewed now; supersede with a new concept |
| `freshness-ageing` | info | Decay strength between the ageing and fresh thresholds | Mark reviewed now |
| `freshness-future` | info | Before `validFrom` | Make it valid now |
| `freshness-recorded` | info | Recorded decay strength far from the computed value | Record the computed value |
| `temporal-invalid` | warning | Inconsistent temporal data (bad duration, `validUntil` before `validFrom`, …) | Convert "90 days" → `P90D`; swap the dates; add a missing `halfLife` / `ttl`; reconcile strength aliases |

## Citations, provenance, compression

| Code | Severity | Meaning | Fixes |
|---|---|---|---|
| `citation-invalid` | error | `citations` is not a list, or an entry is not an object | Remove it |
| `citation-required` | error | A required citation field is missing | `@type`; `other` / `background` fallbacks |
| `citation-key` | error | A field citations do not allow, or an old name (`type`, `role`, …) | Rename; move into `note` |
| `citation-type` | error | Not a standard or namespaced citation type | The likely type; `other` |
| `citation-role` | error | Not a standard or namespaced citation role | The likely role; `background` |
| `citation-title` | error | Empty title | — |
| `citation-url` | error | Not a valid URI | Add `https://` |
| `citation-relevance` | error | Relevance not a number from 0 to 1 | Clamp; remove |
| `citation-date` | error | `date` / `accessed` not `YYYY-MM-DD` | Normalise |
| `citation-note` | error | `note` over 1000 characters | Move it to `## Citations` |
| `citation-author` | warning | Empty or unusable author | Remove it |
| `citation-duplicate` | warning | Two citations with the same URL | — |
| `citation-body-only` | warning | A `## Citations` entry with no frontmatter citation | Add body-only citations to frontmatter |
| `citation-mirror-drift` | warning | A `## Citations` entry differs from frontmatter | Update the section |
| `citation-not-in-body` | info | A citation missing from an existing `## Citations` section | Update the section |
| `provenance-confidence` | info | Confidence outside the usual range for the source type (§12.1) | — |
| `provenance-trust` | info | `user_stated` without a user source, or an import marked highly trusted | — |
| `provenance-empty` | info | `provenance` is empty but still counts for Level 3 | — |
| `compressed-at-name` | warning | `compressed_at` (the pre-1.4 spelling) | Rename to `compressedAt` |
| `compression-no-summary` | warning | Marked compressed, with no `summary` | — |
| `compression-future` | warning | `compressedAt` in the future | — |
| `compression-candidate` | info | Long and old (or weak), per §5.6.2 | Compress (with a summary) |
