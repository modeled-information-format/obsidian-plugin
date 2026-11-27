---
id: d4a5f6e7-91a2-4dbe-af30-4b5c6d7e8f90
type: episodic
created: 2026-08-21T09:00:00Z
namespace: _episodic/incidents
title: Rate Spike Incident 2026-08
summary: Gateway saturation on 2026-08-21 from one batch client.
tags:
  - gateway
---

# Rate Spike Incident 2026-08

On 2026-08-21 the API gateway saturated for about twenty minutes. An internal reporting job was pointed at production with no limiter and issued about 11k requests a minute. Requests were shed with HTTP 503 until the key was throttled at the edge.
