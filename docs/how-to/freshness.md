---
diataxis_type: how-to
title: Track freshness and validity
description: See which concepts are expired, stale, or not yet valid, renew or review them, and tune the thresholds.
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
