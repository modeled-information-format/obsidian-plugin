# MCP evals through a real client

These run the vault's MCP server through Claude Code, headless, and check
what actually happened: what the client sent, what the server answered,
what Claude Code said, and what ended up in the vault.

They exist because the unit tests cannot see a client. `tests/mcp.test.ts`
calls the server with the SDK's own client and well-formed arguments. It
did not catch that Claude Code splits a prompt's arguments on spaces, passes
only the first word to a one-argument prompt, and shows the model a result's
structured copy in place of its text.

## How it works

`run.mjs` starts a recording proxy in front of the vault's server for each
Claude Code session and points the session's MCP config at it. Each case in
`cases.mjs` is checked against:

- the **traffic**: every request, its arguments, and the answer;
- the **answer** Claude Code printed;
- the **vault**: the notes on disk.

A `check` passes or fails. A `fact` only records what the client did where
the server has no say.

## Three kinds of case

| Kind | What runs | What it proves |
|---|---|---|
| client | No tool may run. | What Claude Code itself sends: a prompt's arguments, a resource read, the capabilities it declares. |
| directed | The model is told the exact call to make. | The server's function as it arrives through a real client. Checked on the recorded call and the vault, never on the model's wording. If the model makes a different call it is asked once more, and the retry is shown. |
| agent | The model decides what to do. | Whether a model finds its way with the tools and prompts as described. Run three times; a case passes if most runs do. |

## Running

Needs the plugin's test vault open in Obsidian with the MCP server on,
`claude` on the PATH and signed in. For the default mode, "Allow MCP
writes" must be on, "MCP write limit" raised to 200 or more for the run
(the cases make more writes than the default 30 in 10 minutes allows), and
`test-vault/` must have no uncommitted changes.

```bash
npm run build && npm run install-vault
```

Open the test vault in Obsidian, then:

```bash
npm run eval:mcp-client
```

A full run is about 140 Claude Code sessions. To run part of it:

```bash
node evals/mcp-client/run.mjs --area "get concept,relationships"
```

```bash
node evals/mcp-client/run.mjs --only create,merge,supersede --keep
```

With "Allow MCP writes" turned off in the test vault:

```bash
node evals/mcp-client/run.mjs --mode writes-off
```

To check the cases themselves without Claude Code (the directed calls are
sent straight to the server; this says nothing about the client):

```bash
node evals/mcp-client/run.mjs --dry
```

Other flags: `--jobs <n>` (read cases at once, default 4), `--repeat <n>`,
`--dump` (write all recorded traffic to `results/traffic.json`).

Results are printed and written to `evals/mcp-client/results/` (not
tracked): `latest-<mode>.md` and `.json`.

## What is covered

| Area | Cases | Kind |
|---|---|---|
| Connection | protocol revision, the lists and their sizes, no output schemas, elicitation declared, a change subscription opened | client |
| Prompts | all six prompts as typed commands: no argument, quoted, unquoted, more words than arguments, a real filter, two arguments | client |
| Resources | a concept and an ontology read at their urns, a urn nothing carries, and a typed mention of a concept | client, agent |
| Search | by meaning, similar to a concept, a cosine floor, no query | directed |
| Get concept | by id, path and title; without body; one section; a missing section; truncation; citations and provenance; expired; `as_of`; a bad date; not found; an ambiguous title | directed |
| Relationships | both directions, incoming only, by type, an unknown type, counts only (text and JSON), depth, intersect, path between two, neighbour counts | directed |
| List concepts | by type, folder and title; expired hidden and shown; grouped; two pages; by relationship count; an unknown value | directed |
| Entities | grouped, core types, a bad bundle | directed |
| Status | graph, store, gaps, JSON text | directed |
| Agent reads | title lookup with weighing, incoming relationships, an expired concept, the text reaching the model, recall and consolidate prompts end to end | agent |
| Writes | ingest; create (linked, cited, marked); three refusals; near-duplicate cancelled and asked; edit summary and section; a mirrored section refused; relationship add, twice, to itself, update unagreed and agreed, remove; citation with and without url; entity of an unknown and a core type; entity reference by name; merge; supersede unagreed and agreed; awaiting-review count | directed |
| Agent writes | no type chosen, no agreement given, the capture prompt end to end | agent |
| Writes off | seven tools and two prompts, the guide's wording, a read, an attempted write | all three |

Write cases change notes under `test-vault/`. The runner undoes them from
git afterwards: new notes are deleted, changed ones restored, and the
entity records it made are removed.

## What is not covered, and why

- **The user answering an elicitation.** A headless session can only
  decline. That nothing is written without an answer is covered; that the
  right thing is written after one is covered by the unit tests and by
  hand (`docs/MCP-client-check.md`, checks 6 and 7).
- **A notification changing what the client shows.** Claude Code opens
  the subscription; whether its tool list or an attached resource then
  refreshes needs a person (checks 9 and 10).
- **A typed `@` mention attaching a resource by itself.** In a headless
  session the model reads a resource with Claude Code's own tool when it
  chooses to; the mention does not force a read. The cases ask for the
  read outright, and separately check that a mention gets the model to
  the note by either route. Picking a resource from the `@` list in the
  app is checked by hand (check 4).
- **The gap report as a task.** Claude Code declares the Tasks extension
  on `server/discover` but not on a tool call, so it never gets a task.
  The unit tests cover the task path.
- **The "note is being edited" refusal, the write limit, several bundles,
  and duplicate ids.** They need an open editor, a low limit, or a vault
  laid out differently. The unit tests cover them.
- **The review panel.** It is Obsidian UI, not MCP.
- **Scale.** The test vault has about 35 concepts. The comparison with
  file access on a 1,306-concept vault is a separate evaluation.
- **Other clients and models.** One client and version, recorded with
  every run; directed cases use the `haiku` alias and the rest `sonnet`.

The model's part is not deterministic. Agent cases are repeated for that
reason, and their pass counts are reported, not hidden.
