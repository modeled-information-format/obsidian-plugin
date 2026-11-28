---
id: 638c4943-f37d-4ba4-a366-8226037ab257
type: procedural
created: 2026-11-28T00:39:07Z
modified: 2026-11-28T00:39:07Z
namespace: _procedural/learning
title: Install the vault memory skill for Claude Code and run its test cases
tags:
- how-to
- mcp
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-11-28T00:39:07Z
  recordedAt: 2026-11-28T00:39:07Z
  ttl: P1Y
relationships:
- type: relates-to
  target: mcp-server.md
- type: relates-to
  target: ../reference/mcp.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Install the vault memory skill for Claude Code and run its test cases
  entity_type: how-to-guide
description: Copy the mif-vault-memory skill into Claude Code so an agent connected to a vault's MCP server finds, links and adds concepts in few calls, and run the skill's test cases with and without it.
diataxis_type: how-to
---

# Install the vault memory skill for Claude Code and run its test cases

The repository ships a skill, `skills/mif-vault-memory/`, that tells an
agent which of the MCP server's tools to combine, and in what order, to
answer from a vault and to add to it. Use this when Claude Code is already
connected to a vault.

## Prerequisites

- A clone of this repository.
- Claude Code connected to a vault's MCP server: see
  [Give an AI agent your vault as memory over MCP](mcp-server.md).
- To run the test cases: Node 22 or later, and `claude` on your `PATH`,
  signed in.

## Install the skill

1. From the repository's folder, copy the skill and its reference file,
   without its test cases, to your personal skills folder:

   ```bash
   mkdir -p ~/.claude/skills/mif-vault-memory/references && cp skills/mif-vault-memory/SKILL.md ~/.claude/skills/mif-vault-memory/ && cp skills/mif-vault-memory/references/*.md ~/.claude/skills/mif-vault-memory/references/
   ```

   To ship it inside a Claude Code plugin instead, copy the same two paths
   into that plugin's `skills/mif-vault-memory/` folder.

2. Start a new Claude Code session and type `/mif-vault-memory`. The skill
   is offered as a command.

After an update to this repository, repeat step 1: the installed skill is a
copy.

## Run the test cases

Each folder under `skills/mif-vault-memory/evals/` is one case: `prompt.md`
is what the user says, `case.yaml` describes a good result, and `graders/`
holds one checkable statement per file.

1. Install dependencies and build the generated validators:

   ```bash
   npm ci && npm run -s validators
   ```

2. Run every case with and without the skill:

   ```bash
   node scripts/eval-skill.mjs --iteration 1
   ```

   Each run gets its own in-memory vault, so no vault of yours is read or
   changed. To run some cases only, add `--only` with their folder names,
   separated by commas.

3. Read the results under
   `skills/mif-vault-memory-workspace/iteration-1/<case>/<with_skill|without_skill>/`:
   `outputs/answer.md`, `outputs/tool-calls.md`, `outputs/notes-changed.md`,
   and `timing.json` (tokens, cost, vault calls). Git ignores this folder.

The command prints one line per run and exits with status 1 if any run
failed. A failed run has its reason in the `failed` field of its
`timing.json`; leave its numbers out of any total.

## Relationships

- relates-to [Give an AI agent your vault as memory over MCP](mcp-server.md)
- relates-to [MCP server](../reference/mcp.md)
