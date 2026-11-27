---
id: ea1df436-4f66-4229-acbe-321b20c7d603
type: procedural
created: 2026-11-27T06:30:00Z
modified: 2026-11-27T06:30:00Z
namespace: _procedural/learning
title: Give an AI agent your vault as memory over MCP
tags:
- how-to
- mcp
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-11-27T06:30:00Z
  recordedAt: 2026-11-27T06:30:00Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source and from runs of evals/mcp-client against Claude Code 2.1.332
relationships:
- type: relates-to
  target: ../reference/mcp.md
- type: relates-to
  target: ../reference/settings.md
- type: relates-to
  target: semantic-search.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Give an AI agent your vault as memory over MCP
  entity_type: how-to-guide
description: Turn on the plugin's MCP server for a vault, connect Claude Code to it, let an agent read and, if you choose, write concepts, and review what it wrote (desktop only).
diataxis_type: how-to
---

# Give an AI agent your vault as memory over MCP

Desktop only. The plugin can serve a vault's concepts, typed relationships
and semantic search to an MCP client running on the same computer, such as
Claude Code. The server is off until you turn it on, for each vault
separately. It listens on `127.0.0.1` only.

## 1. Turn the server on

1. **Settings → MIF → MCP server (desktop):** turn it on. The description
   under the switch shows the address, for example
   `http://127.0.0.1:27182/mcp`. The first time, the plugin generates a
   token for this vault.
2. **Vault purpose:** write one line saying what this vault's memory is for.
   An agent connected to several vaults uses it to choose between them.

If the switch turns itself back off, the description says why. The usual
reason is that the port is in use: see *Use several vaults* below.

## 2. Connect Claude Code

1. **Settings → MIF → MCP token → Copy client command.** The command on the
   clipboard contains the token.
2. Paste it into a terminal in the folder you work in. It has this form:

   ```bash
   claude mcp add --transport http mif-vault-<vault> http://127.0.0.1:27182/mcp --header "Authorization: Bearer <token>"
   ```

3. Start Claude Code and run `/mcp`. The server shows as connected, with its
   tools, resources and prompts counted.

A client must run on this computer and accept a `localhost` address. A
connector added in Claude's web or desktop settings cannot reach
`127.0.0.1`.

## 3. Ask about what the vault holds

Ask in your own words; the agent has tools to read a concept by its title,
follow relationships, list concepts by their facts, and search by meaning.
Every answer from the vault states the concept's freshness and trust, so
the agent can tell you how far to rely on it.

The server also offers prompts, which Claude Code shows as commands:

```text
/mcp__mif-vault-<vault>__mif_vault_recall rate limits
```

```text
/mcp__mif-vault-<vault>__mif_vault_guide
```

To hand the agent one concept, type `@`, choose the server, and pick the
concept by its title.

Search by meaning needs `mif-cli` and an ingested bundle: see
[Search concepts by meaning with mif-cli](semantic-search.md). Without them
the agent is told so and uses titles and lists.

## 4. Let an agent write, if you want that

Agents can only read until you turn **Settings → MIF → Allow MCP writes**
on. With it on, an agent can:

- create a concept, or supersede one (the old concept is kept, with its
  validity ended, and relationships that other concepts declared to it are
  pointed at the new one);
- edit a concept's text, or merge concepts into one;
- add, change or remove a typed relationship;
- add a citation, record an entity, or add an entity reference;
- bring the vector store up to date.

What protects the vault:

- A note you are editing is never written to. The agent is told to try
  again later.
- A change that would make a note invalid MIF is refused.
- Superseding a concept, and changing or removing a relationship, need your
  agreement: Claude Code shows a form, and nothing happens until you answer.
- A notice appears in Obsidian for every write, and every write is recorded
  in `mcp-audit.log` in the plugin's folder.
- **MCP write limit** caps writes at 30 in 10 minutes unless you change it.

## 5. Review what an agent wrote

A concept an agent writes, edits or merges into is marked as unverified,
with the agent's name. Until you review it, anyone recalling it is told its
trust is "uncertain".

1. The status bar shows **MIF review** with a count when anything is
   waiting. Click it, or run **MIF: Open agent review panel**.
2. For each concept: open it, read it, then either
   - choose a trust level and **Promote** ("User stated" is the default), or
   - **Reject**, which moves it to the trash. If it superseded a concept,
     that concept becomes valid again, and relationships that were pointed
     at the rejected concept point at it again.

## Use several vaults

Each vault has its own port and token, so several can serve at once. Give
the second vault a different **MCP port**, and add it to Claude Code with
its own copied command. A client pointed at the wrong vault's port is
refused, because the token is another vault's.

## If something does not work

| What you see | What to do |
|---|---|
| The switch turns itself off; the description says the port is in use | Another vault or program has the port. Set a different **MCP port**. |
| Claude Code reports 401 or "unauthorized" | The token changed. Copy the client command again and re-add the server. |
| The description says `mcp.cjs` is missing | Reinstall the plugin's files. The plugin writes this file itself when the server first starts. |
| The agent says search is unavailable | Set up `mif-cli` and ingest the bundle, or let it work from titles and lists. |
| A prompt run as a command seems to get only its first word | Claude Code passes a prompt's arguments word by word. The prompts tell the agent to use everything you typed, so carry on; quoting does not help. |
| The agent cannot write | **Allow MCP writes** is off, or the write limit was reached; the agent's error says which. |

## Relationships

- relates-to [MCP server](../reference/mcp.md)
- relates-to [Settings](../reference/settings.md)
- relates-to [Search concepts by meaning with mif-cli](semantic-search.md)
