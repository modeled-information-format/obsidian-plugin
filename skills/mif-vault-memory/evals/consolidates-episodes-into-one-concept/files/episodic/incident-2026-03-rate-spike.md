---
id: b2e3d4c5-7f80-4b9c-8d1e-2f3a4b5c6d7e
type: episodic
created: 2026-03-14T09:00:00Z
namespace: _episodic/incidents
title: Rate Spike Incident 2026-03
summary: Gateway saturation on 2026-03-14 from one batch client.
tags:
  - gateway
---

# Rate Spike Incident 2026-03

On 2026-03-14 the API gateway saturated for about twenty minutes. A partner's nightly export job ran without a rate limiter and issued about 9k requests a minute. Requests were shed with HTTP 503 until the key was throttled at the edge.
