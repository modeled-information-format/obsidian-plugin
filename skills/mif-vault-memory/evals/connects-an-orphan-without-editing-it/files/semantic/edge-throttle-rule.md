---
id: 5e0f7a21-3b4c-4d5e-8f60-7a1b2c3d4e5f
type: semantic
created: 2026-01-09T10:00:00Z
namespace: _semantic/policies
title: Edge Throttle Rule
summary: The edge proxy throttles any single API key above the configured rate.
tags:
  - gateway
---

# Edge Throttle Rule

The edge proxy applies a per-key throttle. A key that exceeds the configured rate is slowed at the edge before its requests reach the gateway.
