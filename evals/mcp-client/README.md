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

`run.mjs` starts a recording proxy in front of the server for each Claude
Code session and points the session's MCP config at it. Each case in
`cases.mjs` is checked against:

- the **traffic**: every request, its arguments and the answer, and every
  notification the server sent down the client's change subscription;
- the **answer** Claude Code printed;
- the **vault**: the notes afterwards;
- the **questions** the server asked the user, when a case answers them.

A `check` passes or fails. A `fact` only records what the client did where
the server has no say.

## Two servers

| `--server` | What it is | Use it for |
|---|---|---|
| `memory` (default) | The real endpoint, service, host and manager over the in-memory vault the unit tests use, loaded from the tracked test notes and fixtures. No Obsidian. A clean vault for every mode, and the runner can change settings, open an editor, or edit a note while a client is connected. | Everything that does not need the vector store. Reproducible; runs anywhere `claude` is signed in. |
| `live` | The plugin's test vault, open in Obsidian. | The cases that need mif-cli and a vector store: search, the store and gap reports, ingest, the duplicate check. Also a check that the built plugin behaves as the in-memory server does. |

The in-memory server has no mif-cli. Cases marked as needing the store are
left out of a `memory` run and say why.

## Three kinds of case

| Kind | What runs | What it proves |
|---|---|---|
| client | No tool may run. | What Claude Code itself sends: a prompt's arguments, the capabilities it declares, the subscription it opens. |
| directed | The model is told the exact call to make. | The server's function as it arrives through a real client. Checked on the recorded call and the vault, never on the model's wording. If the model makes a different call it is asked once more, and the retry is shown. |
| agent | The model decides what to do. | Whether a model finds its way with the tools and prompts as described. Run three times; a case passes if most runs do. |

## Four modes

Each mode is a set of plugin settings. The in-memory server is started with
them; a live vault must already be set that way.

| `--mode` | Settings | Cases |
|---|---|---|
| `writes-on` | Allow MCP writes on | nearly all of them |
| `writes-off` | Allow MCP writes off | the lists, the guide, a read, an attempted write |
| `limit` | write limit 3 | three writes admitted, the fourth refused, reads unaffected |
| `bundles` | a second bundle root, `_fixtures/rel` | lists and reports per bundle, a concept created in a named bundle, a relationship across bundles |

`--server memory` runs all four by default. `--server live` runs `writes-on`
unless told otherwise.

## Running

Needs `claude` on the PATH and signed in.

```bash
npm run eval:mcp-client
```

That is the in-memory suite, all modes: about 160 Claude Code sessions.

Against the live test vault (open it in Obsidian first, with the MCP server
and "Allow MCP writes" on, "MCP write limit" raised to 200 or more for the
run, and no uncommitted changes under `test-vault/`):

```bash
npm run build && npm run install-vault
```

```bash
node evals/mcp-client/run.mjs --server live
```

Part of a suite:

```bash
node evals/mcp-client/run.mjs --area "get concept,relationships"
```

```bash
node evals/mcp-client/run.mjs --mode limit,bundles
```

To check the cases themselves without Claude Code (each directed call is
sent straight to the server; this says nothing about the client):

```bash
node evals/mcp-client/run.mjs --dry
```

Other flags: `--only <id,id>`, `--jobs <n>` (read cases at once, default
4), `--repeat <n>`, `--agent-model <alias>` (the model for agent cases;
directed cases use `haiku`, the rest `sonnet`), `--keep` (leave a live
vault's changes in place), `--dump` (write all recorded traffic),
`--cases <file>` and `--vault <dir>` (another set of cases against another
live vault).

Results are printed and written to `evals/mcp-client/results/` (not
tracked).

## How a case answers the server's questions

The server asks the user by elicitation before it removes or replaces
something, and when a choice is the user's to make. A headless session has
no user, so by default the question goes unanswered and the case checks
that nothing was written.

A case with an `answer` gives Claude Code an `Elicitation` hook
(`answer.mjs`) that answers as the case says: `{ confirm: true }`,
`{ choice: "derived-from" }`, or `"decline"`. The hook also records what
was asked, so the case can check the question's wording and the choices
offered.

## What is covered

| Area | Cases | Kind |
|---|---|---|
| Connection | protocol revision; the lists and their sizes; no output schemas; every resource a `urn:mif:` id; elicitation declared; a change subscription opened | client |
| Prompts | all six as typed commands: no argument, quoted, unquoted, more words than arguments, a real filter, two arguments | client |
| Resources | a concept and an ontology read at their urns; a urn nothing carries; a typed mention of a concept | client, agent |
| Search | by meaning, similar to a concept, a cosine floor, no query (live); search without mif-cli (memory) | directed |
| Get concept | by id, path and title; without body; one section; a missing section; truncation; citations and provenance; expired; `as_of`; a bad date; not found; an ambiguous title; an id two notes share; an argument the tool does not have | directed |
| Relationships | both directions, incoming only, by type, an unknown type, counts only (text and JSON), depth, intersect, path between two, neighbour counts | directed |
| List concepts | by type, folder and title; expired hidden and shown; grouped; two pages; by relationship count; a bundle the vault lacks; a misspelt filter; an unknown value | directed |
| Entities | grouped, core types, a bad bundle | directed |
| Status | graph, JSON text; store and gaps (live) | directed |
| Agent reads | title lookup with weighing, incoming relationships, an expired concept, the text reaching the model, the recall and consolidate prompts end to end | agent |
| Writes | ingest (live); create (linked, cited, marked); three refusals; near-duplicate cancelled, asked and answered (live); edit summary and section; a mirrored section refused; relationship add, twice, to itself, update unagreed and agreed, remove; citation with and without url; entity of an unknown and a core type; entity reference by name; merge; supersede unagreed and agreed; the awaiting-review count | directed |
| A note being edited | the active editor; unsaved text in another editor (memory); the same change once released | directed |
| The user answers | a type chosen; a removal declined; a removal agreed; a supersession agreed; "keep both" for a near-duplicate (live) | directed |
| Notifications | a concept created while a client listens; writes switched off mid-session, and whether Claude Code asks for the tool list again (memory) | agent |
| Agent writes | no type chosen, no agreement given, the capture prompt end to end | agent |
| Writes off | seven tools and two prompts, the guide's wording, a read, an attempted write | all three |
| Write limit | three admitted, the fourth refused with when to retry, reads unaffected | directed |
| Two bundles | a report and a list for one bundle; the gap report and a new concept asking which; a concept created in the named bundle; a relationship across bundles by id | directed |

A live run changes notes under `test-vault/`. The runner undoes that from
git afterwards: new notes are deleted, changed ones restored, and the
entity records it made are removed.

## What is not covered, and why

- **What the elicitation form looks like, and a person filling it in.**
  The hook answers in the person's place. `docs/MCP-client-check.md`,
  checks 6 and 7, is the manual check.
- **A typed `@` mention attaching a resource by itself.** In a headless
  session a mention stays plain text (Claude Code's documentation says
  so); the model reads the resource with Claude Code's own tool when it
  chooses to. The cases ask for the read outright, and separately check
  that a mention gets the model to the note by either route. Picking a
  resource from the `@` list in the app is checked by hand (check 4).
- **Claude Code refreshing prompts or resources on a notice.** A headless
  session refreshes only its tool list, which is covered. What the
  interactive app does is checked by hand (checks 9 and 10).
- **The gap report as a task.** Claude Code declares the Tasks extension
  on `server/discover` but not on a tool call, so it never gets a task.
  The unit tests cover the task path.
- **The review panel.** It is Obsidian UI, not MCP. The unit tests cover
  promote and reject.
- **Scale.** The test vault has about 35 concepts. The same runner can put
  questions to a larger live vault with `--cases` and `--vault`; that set
  is not in this repository, because the vault it was written for is
  private.
- **Other clients.** One client, whose name and version are recorded with
  every run.

The model's part is not deterministic. Agent cases are repeated for that
reason, and their pass counts are reported, not hidden.
