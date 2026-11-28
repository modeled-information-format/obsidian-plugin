# Growing a rich, well-linked graph

Read this before you capture, link, enrich, consolidate or tidy. It is
about what to write and in what order so the graph gets denser and more
accurate per write, not about the tools' rules (the tools state those).

## Contents

- What makes a concept findable
- Capture: one fact, fully linked, in two calls
- Choosing relationship types
- Entities are the join points
- Enrich a thin concept
- Link a neighbourhood from the gap report
- Consolidate events into knowledge
- Changed, duplicated, wrong
- Tidy on a budget
- After a batch

## What makes a concept findable

A concept earns its place when every play for finding things can reach it.
Aim for all of these on each concept you write or improve:

- **One claim.** Split "the limit is 600 and we page at 800 ms" into two
  concepts and relate them. Atomic concepts can each be superseded, cited
  and linked on their own; a bundle of claims can only be edited.
- **A title that states the subject**, in the words someone would search
  with. Keep any code the vault's titles carry.
- **A summary** of one or two sentences. Lists and searches show it, so a
  reader can decide without opening the body.
- **Type, namespace and entity type that the vault already uses.** Take
  them from the write tool's argument descriptions, which list this
  vault's, or from the neighbours your one search returned. Never spend a
  call to look them up. An invented namespace is a filter nobody will
  ever apply.
- **At least two relationships**: one *up* (what it derives from, is part
  of, or is governed by) and one *across or down* (what it affects,
  supports or sits beside). One link makes a leaf; two make a path.
- **Its named things as entities**, so the concept shows up under them.
- **Where the claim came from**: a citation when there is a document or
  page, or a sentence in the body naming the meeting, person or
  observation.

## Capture: one fact, fully linked, in two calls

1. **Find its place.** One `search_concepts` on the claim, `mode:
   "semantic"`, `limit: 5`. From the result decide: is this new, does it
   replace something, does it duplicate something, and which hits are its
   neighbours. If search is unavailable, `list_concepts` with
   `title_contains` on the subject's key word.
2. **Write it whole.** One `write_concept` with `title`, `summary`, `body`,
   `type`, the neighbour's `namespace` and `entity_type`, and in the same
   call its `relationships`, `entities` and `citations`. Do not create
   first and link afterwards: that is three writes against the limit and
   leaves an orphan if the session ends.

That is the whole capture: at most two reads, then the write. No listing
by namespace or type first, no reading back afterwards.

## Choosing relationship types

Use the types the vault's concepts already carry; the relationship
argument's examples and any concept's counts list them. Pick the most
specific true one:

| The new concept… | Reach for a type like |
|---|---|
| exists because of an event or an earlier claim | `derived-from` |
| replaces an earlier claim | `supersedes` (written for you by the supersede operation) |
| limits or governs something | `constrains`, `governs` |
| needs something to hold | `depends-on` |
| is one piece of something larger | `part-of` |
| is evidence for or against | `supports`, `contradicts` |
| is about the same subject, nothing more specific is true | `relates-to` |

`relates-to` is the weakest link: it tells a reader two things are near
each other and not how. If a specific type is true, use it; path and
impact questions filter by type, and a graph of only `relates-to` cannot
answer them.

Write the relationship on the concept that *depends*, pointing at what it
depends on. Give `strength` when the vault's relationships carry one.

## Entities are the join points

A person, supplier, system, standard or place that several concepts
mention should be an entity, referenced from each of them. That turns
"everything about <name>" into one call, and joins concepts that share no
words and no declared relationship.

- Before creating one, `list_entities` with `name_contains`: reuse the
  existing urn. Two entities for one supplier split its history in half.
- Record an entity the second time a named thing appears, not for every
  proper noun.
- Give the reference a `role` (subject, author, supplier, location) when
  the concept's relation to the thing is specific.

## Enrich a thin concept

When a concept you read has few or no relationships, no entities and no
source, and the conversation gave you what is missing:

1. `get_concept` with `include_body: false` to see what it already has.
2. `search_concepts` with `similar_to` it, `limit: 5`, to find the
   neighbours it should be joined to.
3. Add what is true: `write_relationship` for each link,
   `write_reference` for an entity or a citation.

Leave its text alone unless it is wrong. An edit sends the concept back to
the owner's review; a new link does not change what it says.

## Link a neighbourhood from the gap report

`get_status` with `report: "gaps"` lists pairs that are alike and not
related, and pairs that are related and not alike. It is slow and, on a
large vault, long. Always give it a `scope` (an `entity_type`, `namespace`
or `folder`) and a `limit`, and work one scope at a time.

For each unlinked pair, decide from titles and summaries, which the report
gives; open a body only when the pair's relation is unclear:

- they say the same thing → merge (ask the user which survives);
- one follows from, constrains or depends on the other → add that typed
  relationship on the dependent one;
- they are merely near → `relates-to`, or leave them;
- the similarity is an accident of wording → leave them.

For each doubtful relationship, read both outlines and either leave it,
change its type, or propose removing it. Changes and removals ask the
user, so collect them and put them in one list.

## Consolidate events into knowledge

Several episodic concepts on one subject (incidents, meetings, purchases)
usually imply a standing fact nobody wrote down. To write it:

1. One `list_concepts` with `type: "episodic"` and a `title_contains` or
   `namespace` for the subject; or one `list_entities` for the thing they
   share, with `include_references`. The lines carry each summary.
2. Read a body only where the summary does not give the fact you will
   state; pass several concepts in one call where the tool allows.
3. Write one semantic concept stating what they add up to, with a
   `derived-from` relationship to each episode. Keep the episodes: they
   are the evidence, and the new concept is only as strong as its links
   back to them.

## Changed, duplicated, wrong

- **The claim changed** → supersede. The old concept stays as history, and
  what pointed at it is pointed at the new one.
- **Two concepts say one thing** → merge into the better-linked one; write
  the merged text yourself so nothing is lost.
- **The text is wrong or thin but the claim stands** → edit, by `section`
  when only one part changes, so the rest is not re-sent.
- **A concept is stale** → ask the owner whether it still holds; reaffirm
  by editing it, or supersede it. Do not guess.

## Tidy on a budget

A vault limits writes per window (30 in 10 minutes unless the owner changed
it), and every write puts a notice and often a review item in front of the
owner. So:

- Survey with rung-1 and rung-2 calls first: counts by freshness and
  trust, orphans (`relationship: {min: 0, max: 0}`), the scoped gap
  report. Reading is free of the limit.
- Propose the changes as one list, most valuable first: merges and
  supersessions, then specific typed links, then entities, then
  `relates-to`.
- Make them in the order agreed, and stop at the limit instead of
  retrying. Say how many remain.

## After a batch

- After five or more writes, `ingest_concepts` once, so search and the
  gap report see the new and changed concepts. Not after one or two.
- Report what was written as one list with paths, and what now waits in
  the owner's review.
