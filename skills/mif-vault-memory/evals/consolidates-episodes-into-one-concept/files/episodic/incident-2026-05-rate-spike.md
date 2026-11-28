---
id: c3f4e5d6-8091-4cad-9e2f-3a4b5c6d7e8f
type: episodic
created: 2026-05-02T09:00:00Z
namespace: _episodic/incidents
title: Rate Spike Incident 2026-05
summary: Gateway saturation on 2026-05-02 from one batch client.
tags:
  - gateway
---

# Rate Spike Incident 2026-05

On 2026-05-02 the API gateway saturated for about twenty minutes. A customer's backfill script retried without backoff and issued about 15k requests a minute. Requests were shed with HTTP 503 until the key was throttled at the edge.
