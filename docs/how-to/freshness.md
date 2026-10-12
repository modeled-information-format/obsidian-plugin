---
id: 4df67b8b-b376-55ec-beb8-9a306ab4029c
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-12T13:49:40Z
namespace: _procedural/learning
title: Track freshness and validity
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
  name: Track freshness and validity
  entity_type: how-to-guide
description: See which concepts are expired, stale, or not yet valid, renew or review them, and tune the thresholds.
diataxis_type: how-to
---

# Track freshness and validity

Freshness is computed live from `temporal` (decay model, `validFrom`,
`validUntil`, `ttl`) and never written back on its own.

## See what needs attention

- **Status bar:** `MIF L2 · ageing 0.62`.
- **File explorer:** coloured dots (turn off with **Freshness dots in the
  file explorer**).
- **MIF: Open freshness panel:** concepts that are expired, stale, ageing, or
  not yet valid, most urgent first. Switch to **All concepts** to see the rest.
- **Related panel:** the valid-time range, recorded date, and freshness at
  the top, and a banner when another concept supersedes or conflicts with it.

## Give a note a freshness state

A concept with no `temporal.decay` is *timeless*: the plugin applies the
`none` model, since MIF leaves the default open. A timeless concept has no
freshness in the status bar, no dot in the file explorer, and appears in the
freshness panel only under **All concepts**, as "no decay", until its `ttl` or
`validUntil` passes and it becomes *expired*.

To give it a state, add `temporal.decay.model` in **MIF: Open properties
panel** or in the frontmatter, with what the model needs:

| `decay.model` | Needs | Reads as |
|---|---|---|
| `step` | `ttl` | Fresh until `ttl` has passed since `recordedAt`, then expired |
| `linear` | `ttl` | Strength falls from 1 to 0 across the `ttl` |
| `exponential` | `decay.halfLife` | Strength halves every `halfLife` |

```yaml
temporal:
  recordedAt: '2026-01-15T10:30:00Z'
  ttl: P90D
  decay:
    model: step
```

## Act on it

Every state has buttons in the freshness panel and the diagnostics panel:

| State | Actions |
|---|---|
| Expired by `validUntil` | **Extend validUntil** by the concept's own validity span (a year if it has none); **Remove validUntil**; **Supersede with a new concept** |
| Expired by `ttl` | **Renew** (sets `recordedAt` to now); **Remove ttl**; **Supersede with a new concept** |
| Stale | **Mark reviewed now** (sets `decay.lastReinforced`); **Supersede with a new concept** |
| Ageing | **Mark reviewed now** |
| Not yet valid | **Make it valid now** (sets `validFrom` to now) |
| Invalid temporal data | Repairs where they are clear: `90 days` → `P90D`, swap reversed dates, add a missing `halfLife` or `ttl` |
| Recorded strength far from the computed one | **Record** the computed value |

**Supersede with a new concept** asks for the new concept's title (starting
from the old one), creates it beside the old note — same type and namespace,
valid from now, with a `supersedes` relationship to the old one, named after
the title — ends the old concept's validity now if it was still open, and
opens the new note for you to write. It is also a command,
**MIF: Supersede this concept with a new one**, for any concept.

## Tune it

**Settings → MIF → Freshness → Thresholds** set the strength for *fresh*
(default 0.75) and *ageing* (default 0.5); below that a concept is *stale*.
The spec defines no bands.

**Track access** (off by default) updates `accessCount` and `lastAccessed`
when you open a concept, at most hourly per note. It writes on read, so
leave it off if you sync the vault with git.
