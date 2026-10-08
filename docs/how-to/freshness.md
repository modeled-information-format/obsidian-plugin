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

| State | Action |
|---|---|
| Expired by `ttl` | **Renew** sets `recordedAt` to now |
| Expired by `validUntil` | Review it, then supersede it with a newer concept or change `validUntil` |
| Stale | **Mark reviewed now** sets `decay.lastReinforced` to now |
| Recorded strength far from the computed one | **Record** the computed value |

## Tune it

**Settings → MIF → Freshness → Thresholds** set the strength for *fresh*
(default 0.75) and *ageing* (default 0.5); below that a concept is *stale*.
The spec defines no bands.

**Track access** (off by default) updates `accessCount` and `lastAccessed`
when you open a concept, at most hourly per note. It writes on read, so
leave it off if you sync the vault with git.
