---
name: mif-vault-memory
description: Playbooks for orchestrating the mif_vault_* tools of a MIF Obsidian vault (MCP servers named mif-vault or mif-vault-<name>) so that a question is answered from the knowledge graph in the fewest calls and tokens, and so that what you add makes the graph richer and better linked. Use it whenever such a server is connected and you are about to look something up, answer a "what do we know / what depends on / how are these related / what changed" question, trace or compare concepts, or capture, link, enrich, consolidate, de-duplicate or tidy the vault. Load it before your first mif_vault_* call in a session.
---

# Orchestrating a MIF vault

The tools describe themselves. This skill is about what they do not say:
which calls to combine, in what order, with which arguments, to get an
accurate answer cheaply, and how to add to the graph so it gets more useful
with every write.

A vault is the first source for whatever its server states as its purpose.
With several connected, pick by purpose. Go through the server even when
the files are in front of you: files cannot show what points at a note.

## Spend little, climb only when needed

Every argument that widens a call costs tokens on every later turn. Start
at the bottom rung and climb only if the answer is not there yet.

| Rung | Gives | How |
|---|---|---|
| 1 Counts | how much there is, by kind | `list_concepts` with `group_by`; `list_relationships` with `counts_only`; `list_entities` with `group_by_type` |
| 2 Lines | which concepts, one line each | the same tools, default `detail: "compact"`, a filter, a small `limit` |
| 3 Outline | one concept's identity, weighing, relationship counts, headings | `get_concept` with `include_body: false` |
| 4 Section | the part that answers | `get_concept` with `section`, or `max_chars` |
| 5 Whole | the full text | `get_concept` default; one or two concepts, not ten |

Habits that waste the most, all seen in real sessions:

- `detail: "full"` on lists and searches. Compact already flags any concept
  that calls for caution. Ask for full only for the one or two concepts
  whose weighing you will quote.
- `include_expired: true` by reflex. Use it for history questions only.
- `include_frontmatter`, and `include: [citations, provenance, entities]`,
  on every read. Ask for the one you need, on the concept you will cite.
- `list_concepts` with no filter. It is a dump of the vault. Give
  `title_contains`, `namespace`, `entity_type`, `folder` or `group_by`.
- One call per concept. `list_relationships` takes up to 25 concepts.
- Reading neighbours' bodies to learn how they connect. The relationship
  lines already say so; read a body only to quote it.
- Searching again in other words after a hit. Follow the hit's
  relationships instead.

Stop as soon as you can answer and cite. A three-call answer that names its
sources is better than a ten-call one that says the same.

## Finding: pick the play by the shape of the question

Each play is the whole route. `X` is a title, a path, an id, or a code in a
title; all four work wherever a concept is asked for, so never search for
something you can already name.

| The question | Play | Calls |
|---|---|---|
| "What does X say?" | `get_concept` X with `section` or `max_chars` | 1 |
| "What do we know about <topic>?" | `search_concepts` `limit: 5` → `list_relationships` on the top one to three hits as a list, `neighbor_counts: true` → read the one or two concepts that carry the answer | 3 |
| "What depends on / cites / follows from X?" | `list_relationships` X, `direction: "incoming"`, `types` if the question names a kind | 1 |
| "What would change if X changed?" | the same with `depth: 2` | 1 |
| "What do A and B have in common?" | `list_relationships` `[A, B]`, `combine: "intersect"` | 1 |
| "What does A have that B lacks?" | `combine: "subtract"`, A first | 1 |
| "How is A connected to B?" | `list_relationships` A, `path_to: B` | 1 |
| "What do the things X governs belong to?" (a chain) | `list_relationships` X, `path: [{"type": "…"}, {"type": "…"}]` | 1 |
| "Which of X's neighbours matter most?" | `list_relationships` X, `neighbor_counts: true`; compare counts, read none | 1 |
| "What is the most connected / least connected …?" | `list_concepts` with `relationship: {type, direction, min}` and `sort: "relationships"`; `max: 0` with `min: 0` finds orphans | 1 |
| "How much do we have on …?" | `list_concepts` with a filter and `group_by` | 1 |
| "Everything about <person, supplier, standard>" | `list_entities` `name_contains`, `include_references: true` → read what you need | 2 |
| "What did we hold on <date>?" | the play above for the question, plus `as_of` | same |
| "What replaced X?" / "What did X replace?" | `list_relationships` X, `types: ["supersedes"]`, incoming for what replaced it, outgoing for what it replaced | 1 |

Rules that keep the plays accurate:

- **Read the counts before you list.** Every concept view ends with its
  relationships counted by type and direction. They tell you which
  direction and which `types` to ask for, and whether there is anything to
  ask for at all.
- **Incoming is where the answers hide.** A relationship lives on the note
  that declares it. "What uses X" is on the other notes, never on X.
- **A link can be declared from either end, under a paired type.** "A
  constrains B" on A and "B constrained-by A" on B say the same thing, and
  vaults rarely keep both ends complete. When X's counts show a type going
  out and its pair coming in with different numbers, the full answer is
  the union: ask for both in one call (`types: ["constrains",
  "constrained-by"]`, `direction: "both"`), and for a chain run the `path`
  once from each end. Say which end each part came from when they differ.
- **One hop out before "not found".** If search or a title filter finds
  only something near the subject, list its relationships. The answer is
  often a neighbour under another name.
- **When search is unavailable**, the vault is still usable:
  `list_concepts` with `title_contains` or a `namespace`, then the graph.
  Say that search was unavailable; do not answer from general knowledge
  without having looked.
- **Search for meaning, list for facts.** A question with a number, a type,
  a folder, a freshness or a count in it is a `list_concepts` question.
- **Use `similar_to`** to widen from one good concept, not a reworded
  query.

Then answer: name each concept you relied on by title and path. Compact
results mark freshness problems and leave trust out, so before you call an
answer reliable, read the trust of what it rests on: make the last call,
and only that one, `detail: "full"`, or take one representative concept's
outline (rung 3). Never write that nothing was low in trust on the
strength of a compact result. Say what the vault does not hold before
adding anything of your own.

## Growing the graph

Reading well depends on what earlier writers left. A concept that arrives
alone, with a vague title and no entities, is invisible to every play
above.

**Two reads, then write.** Before a write you need one thing: the
neighbours the new concept should be joined to. One search, or one
filtered list, gives them; a second read is for the case where the first
found nothing. Do not make calls to learn the vault's vocabulary. The
write tools' argument descriptions already list this vault's namespaces,
entity types and relationship types, and the search result shows the
neighbours' own. Listing the vault by namespace, type or group before a
write buys nothing and costs a turn each.

A capture, or a link between concepts you can name:

1. One `search_concepts` on the claim with `mode: "semantic"`, `limit: 5`,
   to find what it duplicates, replaces or belongs with. To link a concept
   you can already name, use `similar_to` it instead.
2. One write per concept, carrying its relationships, entities and
   citation in the same call: at least one link to what it follows from or
   is part of, and one to what it affects or sits beside, each with the
   most specific type that is true (`relates-to` only when nothing more
   specific is). Two claims are two concepts, related to each other. To
   join an existing concept, add relationships; leave its text alone.
3. Stop. Do not read back what you wrote, edit it, or re-index after a
   write or two. Tell the user what was written and that it waits for
   their review.

Read `references/cultivation.md` only for the larger jobs: consolidating
events into a standing fact, working the gap report, merging or
superseding, or tidying many concepts inside the vault's write limit.
