---
id: 9d2e4a71-6c3b-4f85-a1d0-7e8b9c0d1f23
type: semantic
created: 2026-11-27T06:40:00Z
modified: 2026-11-27T06:40:00Z
namespace: _semantic/architecture
title: A vault as an agent's memory
tags:
- explanation
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
  sourceRef: Written by an AI agent from the design decisions recorded in ADR-0002 and from the results of the project's evaluations
relationships:
- type: relates-to
  target: ../adr/0002-mcp-server.md
- type: relates-to
  target: ../reference/mcp.md
- type: relates-to
  target: how-the-plugin-reads-mif.md
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: A vault as an agent's memory
  entity_type: explanation
description: Why the plugin serves a vault to AI agents the way it does - as evidence with its age and trust attached, pulled when asked for, with writes that are attributed, reviewed, and never silent.
diataxis_type: explanation
---

# A vault as an agent's memory

The plugin's MCP server lets an AI agent use a vault as memory. This page
is about why it does so in the way it does. For what to do, see the
[how-to](../how-to/mcp-server.md); for what exists, the
[reference](../reference/mcp.md).

## Memory that is weighed, not obeyed

The usual way to give an agent memory is to find stored text that resembles
the question and put it in front of the model. What was written once is
then treated as true now. A note from two years ago about a limit that has
since changed arrives looking exactly like a note from yesterday.

MIF already records what is needed to do better. A concept can say when it
became valid and when it stops being so, how quickly it goes stale, where
it came from, and how far its author trusted it. The server's job is to
make sure none of that is lost on the way to the model. Every result states
the concept's freshness and trust in words. An expired concept is left out
unless it is asked for, and when it is read it says, in a sentence, that it
is history. The agent is told, in each tool's description and in every
result, to treat what it recalls as evidence and to cite it.

This is also why nothing is pushed. The server never volunteers memories
into a conversation. An agent asks, and gets an answer it can weigh.

## Why a graph, when the files are right there

An agent with file access can read a vault's notes directly, and for many
questions that is enough: a note's frontmatter lists the relationships it
declares. The project measured this. On twenty questions over a vault of
1,306 concepts, agents with the server answered all twenty and agents
reading files answered eighteen, at a slightly lower cost in tokens.

The two the file readers missed were of one kind: what points *at* a
concept. A relationship is declared on one note and names another. Reading
the note that is pointed at shows nothing. The server keeps an index of
relationships in both directions, so "what is grounded in this standard"
and "what do these two briefings have in common" are single calls. That is
the specific thing the graph adds. It is not a general improvement, and the
documentation should not claim one.

## Why results are text

A tool can return structured data, text, or both. The server returned both
until it was run through a real client, which showed the model the
structured copy and dropped the text. The text was where freshness, trust
and the next step were written out. A model reading only the data saw
`"freshness": "expired"` as one field among thirty.

So results are text, written to be read, and a program that wants data asks
for it as JSON. The lesson generalises: what a design depends on has to be
in the part of the result the reader actually receives, and only running a
real client shows which part that is.

## Writing without overwriting

When an agent learns something that contradicts what the vault holds, the
obvious move is to edit the note. That destroys the record of what was
believed before and when it stopped being believed, which is exactly what a
memory is for.

The server offers three distinct acts instead. To *supersede* is to write a
new concept and end the old one's validity, keeping both. To *edit* is to
correct or extend a concept while it remains the same claim. To *merge* is
to fold concepts that say the same thing into one, again keeping what was
folded. An agent is told which to use when. A question about what was held
on a past date can still be answered, because nothing was thrown away.

## Who wrote this, and has anyone checked

An agent's writing is useful and unverified. Both facts are recorded. A
concept an agent creates says so, names the client, and carries the lowest
trust level until a person reviews it. The same happens to a concept a
person wrote once an agent has edited it: its trust drops back until it is
looked at again.

Review is done in Obsidian, by a person, and has no tool. That is
deliberate. If an agent could promote what an agent wrote, the trust level
would mean nothing.

Some changes are stopped before they happen. Replacing a concept, and
changing or removing a relationship, ask the user first; the agent cannot
answer for them. A note that is open with unsaved edits is never written
to. Every write shows a notice and is logged. The aim is that nothing an
agent does to a vault is silent.

## Why it lives inside Obsidian, on this computer only

The server runs inside the plugin, not as a separate program. The plugin
already holds the vault's model in memory, already knows which notes are
being edited, and already has the one path by which a note may be written
safely. A second program would have to rebuild all three and could not know
what is in an unsaved editor.

It listens on `127.0.0.1`, per vault, with a token, and is off until turned
on. A vault is private by default, and reaching it should take a decision
for each vault. The cost is that only clients on the same computer can
connect.

## What this does not do

- It does not make an agent right. It makes the age and standing of what
  the agent read visible, to the agent and so to you.
- It does not find what is not written down, and it says so when asked
  about something the vault lacks.
- It depends on the client. Whether a prompt appears as a command, a form
  is shown for a question, or a list refreshes after a change is the
  client's doing. The project tests against Claude Code and records what it
  does.

## Relationships

- relates-to [ADR-0002: An MCP server in the plugin](../adr/0002-mcp-server.md)
- relates-to [MCP server](../reference/mcp.md)
- relates-to [How the plugin reads MIF](how-the-plugin-reads-mif.md)
