---
id: 3b6f0c52-8a1d-4e7b-9c24-5d1e7f6a2b90
type: procedural
created: 2026-11-27T06:40:00Z
modified: 2026-11-27T06:40:00Z
namespace: _procedural/learning
title: Your first session with an agent and your vault
tags:
- tutorial
- mcp
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-11-27T06:40:00Z
  recordedAt: 2026-11-27T06:40:00Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: moderate_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source and from sessions of Claude Code 2.1.332 against the plugin's test vault
relationships:
- type: relates-to
  target: getting-started.md
- type: relates-to
  target: ../how-to/mcp-server.md
- type: relates-to
  target: ../explanation/vault-as-agent-memory.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Your first session with an agent and your vault
  entity_type: tutorial
description: A first session, start to finish - connect Claude Code to a vault, ask it what the vault holds, have it capture one fact, and review what it wrote.
diataxis_type: tutorial
---

# Your first session with an agent and your vault

In this tutorial you connect Claude Code to a vault, ask it a question the
vault can answer, have it write one new concept, and review that concept in
Obsidian. It takes about fifteen minutes.

You need Obsidian on a desktop computer with this plugin enabled, Claude
Code installed, and a vault with one concept in it. If you have no concept
yet, do [Getting started](getting-started.md) first; this tutorial uses the
concept you create there, titled "Dark mode preference".

## 1. Turn the server on

1. Open **Settings → MIF** and scroll to **MCP server (desktop)**.
2. Turn the switch on.

The line under the switch now ends with "Running at
http://127.0.0.1:27182/mcp."

3. In **Vault purpose**, type `My preferences and the decisions behind them`.

## 2. Connect Claude Code

1. Still in the settings, find **MCP token** and click **Copy client
   command**. A notice says the command was copied.
2. Open a terminal, go to any folder, and paste the command. Press Enter.

   The terminal prints that the server was added.

3. Start Claude Code in that folder:

   ```bash
   claude
   ```

4. Type `/mcp` and press Enter.

You see your vault's server, named `mif-vault-` and your vault's name, with
"connected" beside it and a line counting its tools, resources and prompts.
Press Escape to close the list.

## 3. Ask what the vault holds

Type this and press Enter:

```text
Using the mif vault, what is my dark mode preference, and how far can I rely on it?
```

Claude Code asks permission to use a tool from your vault's server. Allow
it.

The answer tells you what the concept says, and then something a plain
search would not: how fresh the concept is and how far it is trusted, as
recorded in the concept's own properties.

That second part is the point of the exercise. The vault does not hand an
agent facts; it hands over what you wrote down, along with how old and how
well-founded it is.

## 4. Let the agent write

1. In Obsidian, in **Settings → MIF**, turn **Allow MCP writes** on.
2. Back in Claude Code, type:

   ```text
   Capture into the mif vault: my editor font is JetBrains Mono at 14 points.
   ```

3. Claude Code asks permission for each tool it uses. Allow them.

Watch Obsidian while it works. A notice appears: "MIF: claude-code created"
followed by the new concept's title. At the bottom right of the window, the
status bar now shows **MIF review 1**.

Claude Code finishes by telling you what it wrote and where, and that it is
waiting for your review.

## 5. Review what it wrote

1. Click **MIF review 1** in the status bar. A panel opens listing the new
   concept, who wrote it, and when.
2. Click the concept's title to open it. Read it.

   In its properties you can see `sourceType: agent_inferred` and
   `trustLevel: uncertain`, and `agent: claude-code`.

3. In the panel, leave the level at **User stated** and click **Promote**.

The concept leaves the panel and the status bar count disappears. Open the
concept again: `trustLevel` now reads `user_stated`. Who wrote it has not
changed.

## 6. See the difference review made

In Claude Code, ask:

```text
Using the mif vault, what is my editor font, and how far can I rely on it?
```

This time the answer reports the trust you gave it.

## What you have done

You served a vault to an agent, saw it report freshness and trust with an
answer, let it write one concept, and decided yourself how far that concept
is to be trusted.

From here:

- [Give an AI agent your vault as memory over MCP](../how-to/mcp-server.md)
  covers several vaults, the write limit, and what to do when something
  does not work.
- [A vault as an agent's memory](../explanation/vault-as-agent-memory.md)
  explains why it works this way.

## Relationships

- relates-to [Getting started](getting-started.md)
- relates-to [Give an AI agent your vault as memory over MCP](../how-to/mcp-server.md)
- relates-to [A vault as an agent's memory](../explanation/vault-as-agent-memory.md)
