// The cases: what to type into Claude Code, and what must then be true of the
// traffic between it and the server, of its answer, and of the vault.
//
// Three kinds:
//   client    no tool may run; the case is about what the client itself sends
//             (a prompt's arguments, a resource read, what it declares).
//   directed  the model is told the exact call to make. The case is about the
//             server's function as it arrives through a real client; what is
//             checked is the recorded call and the vault, never the model's
//             wording. If the model makes a different call it is asked once more.
//   agent     the model decides what to do. These run several times and must
//             pass in most runs, because one run of a model proves little.
//
// A `check` decides pass or fail. A `fact` only records something the server
// has no say in.

export const SERVER = "mif-vault-test-vault";
const TASKS = "io.modelcontextprotocol/tasks";

const POLICY_ID = "urn:mif:7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e";
const POLICY = "semantic/rate-limit-policy.md";
const RUNBOOK = "procedural/rotate-api-keys.md";
const INCIDENT = "episodic/incident-2026-01-rate-spike.md";
const ALPHA = "semantic/Eval-Probe-Alpha.md";
const BETA = "semantic/Eval-Probe-Beta.md";
const GAMMA = "semantic/Eval-Probe-Gamma.md";

const T = {
  search: "mif_vault_search_concepts",
  get: "mif_vault_get_concept",
  rel: "mif_vault_list_relationships",
  list: "mif_vault_list_concepts",
  entities: "mif_vault_list_entities",
  status: "mif_vault_get_status",
  types: "mif_vault_list_entity_types",
  write: "mif_vault_write_concept",
  wrel: "mif_vault_write_relationship",
  wref: "mif_vault_write_reference",
  ingest: "mif_vault_ingest_concepts",
  edit: "mif_vault_edit_concept",
};

// The plugin keeps entity records in memory and does not see one deleted behind its back, so the
// entity the cases record is new on every run.
const RUN = Date.now().toString(36);
const PERSON = `Eval Probe Person ${RUN}`;
const PERSON_SLUG = `eval-probe-person-${RUN}`;

/** One id that two fixture notes carry (tests/fixtures/memories). */
const SHARED_ID = "urn:mif:c3d4e5f6-7890-12cd-ef01-3456789012cd";
const DELTA = "semantic/Eval-Probe-Delta.md";
const NOTICE = "semantic/Eval-Probe-Notice.md";
const noticeNote = `---
id: 5e0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b
type: semantic
created: 2026-11-27T00:00:00Z
title: Eval Probe Notice
---
# Eval Probe Notice

Made by the evaluation while a client was listening.
`;

const prompt = (name, args = "") => `/mcp__${SERVER}__${name}${args ? ` ${args}` : ""}`;

/** True when every key of `want` is in `got` with an equal value. The model may add nothing that matters. */
const subset = (want, got) =>
  want !== null && typeof want === "object"
    ? got !== null && typeof got === "object" && (Array.isArray(want) ? Array.isArray(got) && want.length === got.length && want.every((w, i) => subset(w, got[i])) : Object.entries(want).every(([k, v]) => subset(v, got[k])))
    : want === got;

/** A directed case: one exact tool call, then checks on what the server answered and on the vault. */
function directed(id, area, what, tool, args, verify, extra = {}) {
  return {
    id,
    area,
    what,
    directed: { tool, args },
    input: `Call the tool ${tool} of the ${SERVER} MCP server exactly once, with exactly these JSON arguments and no others. Do not call any other tool. If it returns an error or asks for something, do not retry and do not change the arguments. Then reply with the single word DONE.\n\n${JSON.stringify(args)}`,
    verify(v) {
      const call = v.traffic.of("tools/call", tool).find((c) => subset(args, c.params?.arguments));
      v.check("called as directed", !!call, v.traffic.of("tools/call").map((c) => [c.params?.name, c.params?.arguments]));
      if (!call) return;
      // A call the server answers with a question is made again by the client, carrying the answer; and a
      // model sometimes repeats a call that was refused. Neither is another tool.
      const made = v.traffic.of("tools/call");
      v.check("no other tool was called", made.every((c) => c.params?.name === tool), v.traffic.tools().join(","));
      if (made.length > 1) v.fact("calls made", made.length);
      const text = v.traffic.text(call);
      verify({ ...v, call, text, isError: call.result?.isError === true || !!call.error, asked: call.result?.resultType === "input_required" });
    },
    ...extra,
  };
}
const ok = (v) => v.check("the call succeeded", !v.isError && !v.asked, v.text || v.call.error);
const refused = (v, why) => v.check(`the call was refused${why ? `: ${why}` : ""}`, v.isError, v.text);
const has = (v, ...needles) => needles.forEach((n) => v.check(`the answer has ${JSON.stringify(n)}`, n instanceof RegExp ? n.test(v.text) : v.text.includes(n), v.text.slice(0, 400)));
const lacks = (v, ...needles) => needles.forEach((n) => v.check(`the answer lacks ${JSON.stringify(n)}`, !(n instanceof RegExp ? n.test(v.text) : v.text.includes(n)), v.text.slice(0, 400)));
const json = (v) => {
  try {
    return JSON.parse(v.text);
  } catch {
    v.check("the answer is JSON text", false, v.text.slice(0, 200));
    return {};
  }
};

const NEEDS_STORE = ["ingest", "search-query", "search-similar", "search-floor", "status-store", "status-gaps", "create-duplicate-cancel", "create-duplicate-asks", "create-duplicate-answered"];

export const cases = [
  // ======================================================================================
  // connection
  // ======================================================================================
  {
    id: "connect",
    area: "connection",
    what: "speaks 2026-07-28, asks for the lists, and declares what the server relies on",
    tools: false,
    input: "Reply with the single word: ready",
    verify({ traffic, check, fact, world }) {
      check("protocol revision is 2026-07-28", traffic.protocol() === "2026-07-28", String(traffic.protocol()));
      check("calls server/discover", traffic.of("server/discover").length > 0);
      const tools = traffic.of("tools/list")[0]?.result?.tools ?? [];
      check("lists the tools, and gets all twelve", tools.length === 12, tools.map((t) => t.name));
      check("no tool declares an output schema", tools.every((t) => t.outputSchema === undefined));
      check("lists the prompts, and gets all six", (traffic.of("prompts/list")[0]?.result?.prompts ?? []).length === 6);
      check("lists the resources", (traffic.of("resources/list")[0]?.result?.resources ?? []).length > 0);
      check("every request was accepted", traffic.all.every((t) => (t.status ?? 0) < 400), traffic.all.filter((t) => (t.status ?? 0) >= 400).map((t) => [t.method, t.status]));
      const caps = traffic.capabilities() ?? {};
      // The server asks the user through elicitation and announces changes on a subscription: if a
      // client stops declaring or opening these, the design's guards fall back to their error paths.
      check("declares elicitation", !!caps.elicitation, caps);
      check("opens a change subscription", traffic.of("subscriptions/listen").length > 0);
      fact("client name", `${traffic.clientInfo()?.name ?? "?"} ${traffic.clientInfo()?.version ?? ""}`.trim());
      fact("declares the Tasks extension on server/discover", !!traffic.capsOf(traffic.of("server/discover")[0])?.extensions?.[TASKS]);
      const listed = traffic.of("resources/list")[0]?.result?.resources ?? [];
      check("every resource is addressed by a urn:mif: id", listed.length > 0 && listed.every((r) => r.uri.startsWith("urn:mif:")), listed.filter((r) => !r.uri.startsWith("urn:mif:")).map((r) => r.uri));
      check("concepts, and ontologies at urn:mif:ontology:<id>, are among them", listed.some((r) => /^urn:mif:[0-9a-f-]{36}$/.test(r.uri)) && listed.some((r) => r.uri.startsWith("urn:mif:ontology:")));
      fact("resources the server lists", world.resourceCount);
    },
  },

  // ======================================================================================
  // prompts: what the client sends when a prompt is run as a typed command
  // ======================================================================================
  {
    id: "prompt-guide",
    area: "prompts",
    what: "runs a prompt that takes no argument",
    tools: false,
    input: prompt("mif_vault_guide"),
    verify({ traffic, check }) {
      const p = traffic.prompt("mif_vault_guide");
      check("the prompt was requested", !!p);
      check("its text names the vault", p?.text.includes("test-vault"), p?.text);
      check("it describes writing, since writes are on", p?.text.includes("This vault allows writes"), p?.text.slice(-600));
    },
  },
  {
    id: "prompt-recall-quoted",
    area: "prompts",
    what: "a quoted topic of two words stays one topic",
    tools: false,
    input: prompt("mif_vault_recall", '"rate limits"'),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_recall");
      check("the prompt was requested", !!p);
      fact("arguments as the client sent them", p?.args);
      check("the topic is whole", p?.text.includes("holds about: rate limits\n"), p?.text.slice(0, 200));
      check("no filter was invented", !p?.text.includes("Keep to"), p?.text.slice(0, 300));
    },
  },
  {
    id: "prompt-recall-bare",
    area: "prompts",
    what: "an unquoted topic of three words stays one topic",
    tools: false,
    input: prompt("mif_vault_recall", "api rate limits"),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_recall");
      fact("arguments as the client sent them", p?.args);
      check("the topic is whole", p?.text.includes("holds about: api rate limits\n"), p?.text.slice(0, 200));
      check("no filter was invented", !p?.text.includes("Keep to"), p?.text.slice(0, 300));
    },
  },
  {
    id: "prompt-recall-long",
    area: "prompts",
    what: "a topic longer than the prompt has arguments is flagged to the model as cut short",
    tools: false,
    input: prompt("mif_vault_recall", "how the api rate limit was chosen"),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_recall");
      fact("arguments as the client sent them", p?.args);
      // Three arguments, seven words: the server cannot have them all, so the prompt must say so.
      check("the prompt tells the model to take what was typed", p?.text.includes("the client cut it short"), p?.text.slice(0, 400));
      check("no filter was invented", !p?.text.includes("Keep to"), p?.text.slice(0, 300));
    },
  },
  {
    id: "prompt-recall-filter",
    area: "prompts",
    what: "a second word that is a real entity type is kept as a filter",
    tools: false,
    input: prompt("mif_vault_recall", "lovelace Person"),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_recall");
      fact("arguments as the client sent them", p?.args);
      check("the topic is the first word", p?.text.includes("holds about: lovelace\n"), p?.text.slice(0, 200));
      check("the entity type is a filter", p?.text.includes('Keep to entity type "Person"'), p?.text.slice(0, 300));
    },
  },
  {
    id: "prompt-capture-args",
    area: "prompts",
    what: "a one-argument prompt that the client cuts short says so to the model",
    tools: false,
    input: prompt("mif_vault_capture", '"Burst allowance is 20 requests for ten seconds"'),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_capture");
      check("the prompt was requested", !!p);
      fact("arguments as the client sent them", p?.args);
      fact("the client passed the whole sentence", p?.text.includes("Burst allowance is 20 requests for ten seconds"));
      check("the stray quote is gone", !/vault "test-vault": "/.test(p?.text ?? ""), p?.text.slice(0, 160));
      check("the prompt tells the model to take what was typed", p?.text.includes("the client cut it short"), p?.text.slice(0, 400));
    },
  },
  {
    id: "prompt-consolidate-args",
    area: "prompts",
    what: "an unquoted topic given to a one-argument prompt is flagged as cut short",
    tools: false,
    input: prompt("mif_vault_consolidate", "rate limiting incidents"),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_consolidate");
      check("the prompt was requested", !!p);
      fact("arguments as the client sent them", p?.args);
      check("the prompt tells the model to take what was typed", p?.text.includes("the client cut it short"), p?.text.slice(0, 400));
    },
  },
  {
    id: "prompt-review-stale",
    area: "prompts",
    what: "two arguments in order: a namespace and a number",
    tools: false,
    input: prompt("mif_vault_review_stale", "_semantic/policies 3"),
    verify({ traffic, check, fact }) {
      const p = traffic.prompt("mif_vault_review_stale");
      check("the prompt was requested", !!p);
      fact("arguments as the client sent them", p?.args);
      check("the namespace is used", p?.text.includes('namespace: "_semantic/policies"'), p?.text.slice(0, 400));
      check("the number is used", p?.text.includes("limit: 3"), p?.text.slice(0, 400));
    },
  },
  {
    id: "prompt-curate-links",
    area: "prompts",
    what: "a prompt whose arguments are all optional runs with none",
    tools: false,
    input: prompt("mif_vault_curate_links"),
    verify({ traffic, check }) {
      const p = traffic.prompt("mif_vault_curate_links");
      check("the prompt was requested", !!p);
      check("it leads with the gap report", p?.text.includes('report: "gaps"'), p?.text.slice(0, 300));
    },
  },

  // ======================================================================================
  // resources
  //
  // In a headless session Claude Code does not read a resource because it was mentioned: the model
  // reads it, with Claude Code's own resource tool, when it chooses to. (Found by probing: the same
  // mention was read in some runs and not in others, and never for a concept when a vault tool would
  // also do.) So the reads are asked for outright, and the mention is a separate, agent case.
  // ======================================================================================
  {
    id: "resource-read-concept",
    area: "resources",
    what: "a concept is read as a resource at its canonical id, as markdown",
    tools: false,
    input: `Use your built-in tool for reading MCP resources (not any mif_vault tool) to read the resource ${POLICY_ID} from the ${SERVER} server. Then answer with one number only: the burst allowance it states.`,
    verify({ traffic, answer, check }) {
      const read = traffic.of("resources/read").find((t) => t.params?.uri === POLICY_ID);
      check("the resource was read", !!read, traffic.of("resources/read").map((t) => t.params?.uri));
      check("the server returned the note as markdown, with its weighing", (read?.result?.contents ?? []).some((c) => c.mimeType === "text/markdown" && /600/.test(c.text ?? "") && /freshness: timeless/.test(c.text ?? "")), read?.error ?? (read?.result?.contents ?? []).map((c) => [c.mimeType, (c.text ?? "").slice(0, 120)]));
      check("the answer comes from the note", /\b100\b/.test(answer), answer);
    },
  },
  {
    id: "resource-read-ontology",
    area: "resources",
    what: "an ontology is read as a resource at urn:mif:ontology:<id>, as JSON",
    tools: false,
    input: (w) => `Use your built-in tool for reading MCP resources (not any mif_vault tool) to read the resource ${w.ontologyUri} from the ${SERVER} server. Then answer with the ontology's id only.`,
    verify({ traffic, check, world }) {
      check("the vault lists an ontology at a urn", /^urn:mif:ontology:/.test(world.ontologyUri ?? ""), world.ontologyUri);
      const read = traffic.of("resources/read").find((t) => t.params?.uri === world.ontologyUri);
      check("the resource was read", !!read, traffic.of("resources/read").map((t) => t.params?.uri));
      const text = (read?.result?.contents ?? []).map((c) => c.text ?? "").join("");
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {
        check("the server returned JSON", false, text.slice(0, 200));
      }
      check("it is the ontology's definition", data.uri === world.ontologyUri && Array.isArray(data.entity_types) && typeof data.version === "string", Object.keys(data));
    },
  },
  {
    id: "resource-read-missing",
    area: "resources",
    what: "a urn no concept carries is answered with a not-found error, not a guess",
    tools: false,
    input: `Use your built-in tool for reading MCP resources (not any mif_vault tool) to read the resource urn:mif:00000000-0000-4000-8000-000000000000 from the ${SERVER} server. Reply READ if it returned content, or NOT FOUND if it returned an error.`,
    verify({ traffic, answer, check }) {
      const read = traffic.of("resources/read").find((t) => t.params?.uri === "urn:mif:00000000-0000-4000-8000-000000000000");
      check("the read was attempted", !!read, traffic.of("resources/read").map((t) => t.params?.uri));
      check("the server answered with an error", !!read?.error, read?.result);
      check("the client reported it as not found", /NOT FOUND/i.test(answer), answer);
    },
  },
  {
    id: "resource-mention",
    area: "resources",
    what: "a concept mentioned by its canonical id gets the model to its text, by a resource read or a tool",
    repeat: 3,
    input: `@${SERVER}:${POLICY_ID} According to this note, what is the burst allowance? Answer with the number only.`,
    verify({ traffic, answer, check, fact }) {
      const byResource = traffic.of("resources/read").some((t) => t.params?.uri === POLICY_ID);
      const byTool = traffic.of("tools/call", T.get).some((t) => !t.result?.isError);
      check("the note was fetched by its id", byResource || byTool, traffic.all.map((t) => t.method));
      check("the answer comes from the note", /\b100\b/.test(answer), answer);
      fact("fetched as a resource", byResource);
      fact("fetched with a tool", byTool);
    },
  },

  // ======================================================================================
  // read tools, directed: every tool and its options
  // ======================================================================================
  directed("search-query", "search", "finds a concept by meaning", T.search, { query: "per-key request rate limit on the API gateway" }, (v) => {
    ok(v);
    has(v, "API Rate Limit Policy");
  }),
  directed("search-similar", "search", "finds the concepts nearest to one", T.search, { similar_to: POLICY, limit: 3 }, (v) => {
    ok(v);
    lacks(v, /^\s*-?\s*API Rate Limit Policy\s*$/m);
  }),
  directed("search-floor", "search", "a cosine floor no result reaches returns nothing, without error", T.search, { query: "per-key request rate limit", min_cosine: 0.999 }, (v) => {
    ok(v);
    lacks(v, "API Rate Limit Policy —");
  }),
  directed("search-no-query", "search", "a search with neither a query nor a concept is refused", T.search, {}, (v) => refused(v)),

  directed(
    "search-unavailable",
    "search",
    "without mif-cli, search says so and names what to use instead",
    T.search,
    { query: "rate limit" },
    (v) => {
      refused(v);
      has(v, "Search is unavailable", "mif-cli", /mif_vault_(list_concepts|get_concept)/);
    },
    { server: "memory" },
  ),

  directed("get-by-id", "get concept", "reads a concept by its canonical id", T.get, { concept: POLICY_ID }, (v) => {
    ok(v);
    has(v, POLICY, "freshness: timeless", "600");
  }),
  directed("get-by-path", "get concept", "reads a concept by its vault path", T.get, { concept: POLICY }, (v) => {
    ok(v);
    has(v, "# API Rate Limit Policy", POLICY_ID);
  }),
  directed("get-by-title", "get concept", "reads a concept by its title", T.get, { concept: "API Rate Limit Policy" }, (v) => {
    ok(v);
    has(v, POLICY, "Relationships it declares (outgoing): derived-from 1, relates-to 1.");
  }),
  directed("get-no-body", "get concept", "leaves the text out on request", T.get, { concept: POLICY, include_body: false }, (v) => {
    ok(v);
    has(v, 'Headings: "API Rate Limit Policy", "Rationale"');
    lacks(v, "600");
  }),
  directed("get-section", "get concept", "returns one section", T.get, { concept: POLICY, section: "Rationale" }, (v) => {
    ok(v);
    has(v, "Rationale");
  }),
  directed("get-section-missing", "get concept", "names the headings when a section does not exist", T.get, { concept: POLICY, section: "Nope" }, (v) => {
    refused(v);
    has(v, '"Rationale"');
  }),
  directed("get-truncated", "get concept", "cuts long text at max_chars and says so", T.get, { concept: RUNBOOK, max_chars: 200 }, (v) => {
    ok(v);
    has(v, /cut|truncat|section/i);
    lacks(v, "Confirm the old key returns HTTP 401");
  }),
  directed("get-sources", "get concept", "traces a concept to its citations and provenance", T.get, { concept: "Cited fact", include: ["citations", "provenance"] }, (v) => {
    ok(v);
    has(v, /Citations \(\d+\):/);
  }),
  directed("get-expired", "get concept", "says in words that a concept has expired", T.get, { concept: "Expired policy (validUntil)" }, (v) => {
    ok(v);
    has(v, "freshness: expired", "Caution: this concept has expired. Treat it as history, not as current fact.");
  }),
  directed("get-as-of", "get concept", "judges validity at the date asked about", T.get, { concept: "Future rule", as_of: "2020-01-01" }, (v) => {
    ok(v);
    has(v, "freshness: not-yet-valid", "not valid yet at the date asked about");
  }),
  directed("get-bad-date", "get concept", "refuses a date that is not a date", T.get, { concept: POLICY, as_of: "next week" }, (v) => refused(v)),
  directed("get-missing", "get concept", "says what to do when a concept is not found", T.get, { concept: "No Such Concept Anywhere" }, (v) => {
    refused(v);
    has(v, /mif_vault_(search_concepts|list_concepts)/);
  }),
  directed("get-ambiguous", "get concept", "lists the candidates when a title names several concepts", T.get, { concept: "rate" }, (v) => {
    refused(v);
    has(v, INCIDENT, POLICY);
  }),

  directed("get-shared-id", "get concept", "an id that two notes carry is never resolved to one of them", T.get, { concept: SHARED_ID }, (v) => {
    refused(v);
    has(v, "matches more than one concept", "_fixtures/memories/agriculture/ram-001-breeding-record.md", "_fixtures/memories/publishing/state-adoption-example.md");
  }),
  directed("get-stray-argument", "get concept", "an argument the tool does not have is refused by name, not dropped", T.get, { concept: POLICY, sections: "Rationale" }, (v) => {
    refused(v);
    has(v, "sections");
  }),

  directed("rel-both", "relationships", "lists a concept's relationships in both directions", T.rel, { concept: POLICY }, (v) => {
    ok(v);
    has(v, "3 relationship(s)", "declares derived-from → (1)", "Rate Spike Incident 2026-01", "relates-to declared to it by ← (1)");
  }),
  directed("rel-incoming", "relationships", "lists only what other concepts declare", T.rel, { concept: POLICY, direction: "incoming" }, (v) => {
    ok(v);
    has(v, "Rotate API Keys");
    lacks(v, "- Rate Spike Incident 2026-01");
  }),
  directed("rel-types", "relationships", "keeps to the relationship types asked for", T.rel, { concept: POLICY, types: ["derived-from"] }, (v) => {
    ok(v);
    has(v, "- Rate Spike Incident 2026-01");
    lacks(v, "- Rotate API Keys");
  }),
  directed("rel-unknown-type", "relationships", "names the vault's types when asked for one it does not use", T.rel, { concept: POLICY, types: ["briefs"] }, (v) => {
    refused(v);
    has(v, "relates-to", "derived-from");
  }),
  directed("rel-counts", "relationships", "counts without listing", T.rel, { concept: POLICY, counts_only: true }, (v) => {
    ok(v);
    has(v, "derived-from 1, relates-to 1");
    lacks(v, "- Rotate API Keys");
  }),
  directed("rel-counts-json", "relationships", "a counts-only answer still carries its totals and types", T.rel, { concept: POLICY, counts_only: true, response_format: "json" }, (v) => {
    ok(v);
    const d = json(v);
    v.check("total_count is the sum of the counts", d.total_count === 3, d.total_count);
    v.check("types are those counted", JSON.stringify(d.types) === JSON.stringify(["derived-from", "relates-to"]), d.types);
    v.check("nothing is listed", Array.isArray(d.relationships) && d.relationships.length === 0);
  }),
  directed("rel-depth", "relationships", "follows relationships two hops out", T.rel, { concept: INCIDENT, depth: 2 }, (v) => {
    ok(v);
    has(v, "API Rate Limit Policy", "Rotate API Keys", /hop 2/);
  }),
  directed("rel-intersect", "relationships", "finds what several concepts are both related to", T.rel, { concept: [INCIDENT, RUNBOOK], combine: "intersect" }, (v) => {
    ok(v);
    has(v, /1 concept\(s\) have a/, "API Rate Limit Policy");
  }),
  directed("rel-path-to", "relationships", "finds the chain that connects two concepts", T.rel, { concept: INCIDENT, path_to: RUNBOOK }, (v) => {
    ok(v);
    has(v, "are 2 relationship(s) apart");
  }),
  directed("rel-neighbor-counts", "relationships", "adds each related concept's own counts", T.rel, { concept: POLICY, neighbor_counts: true }, (v) => {
    ok(v);
    has(v, /Rotate API Keys — .*relates-to/);
  }),

  directed("list-by-type", "list concepts", "lists concepts of one type", T.list, { type: "episodic", folder: "episodic" }, (v) => {
    ok(v);
    has(v, "1 concept(s) match", "Rate Spike Incident 2026-01");
  }),
  directed("list-by-folder", "list concepts", "lists concepts under a folder", T.list, { folder: "procedural" }, (v) => {
    ok(v);
    has(v, "1 concept(s) match", "Rotate API Keys");
  }),
  directed("list-by-title", "list concepts", "lists concepts whose title contains a word", T.list, { title_contains: "rate" }, (v) => {
    ok(v);
    has(v, "API Rate Limit Policy", "Rate Spike Incident 2026-01");
  }),
  directed("list-hides-expired", "list concepts", "leaves expired concepts out and says how many", T.list, { folder: "_fixtures/temporal" }, (v) => {
    ok(v);
    lacks(v, "Expired policy (validUntil)");
    has(v, /\d+ expired or not-yet-valid concept\(s\) left out; pass include_expired: true/);
  }),
  directed("list-expired", "list concepts", "lists expired concepts when asked for them, marked", T.list, { freshness: ["expired"], folder: "_fixtures/temporal" }, (v) => {
    ok(v);
    has(v, "Expired policy (validUntil) — EXPIRED");
  }),
  directed("list-grouped", "list concepts", "counts concepts by a fact instead of listing them", T.list, { group_by: "type" }, (v) => {
    ok(v);
    has(v, /by type:/, /semantic: \d+/);
  }),
  directed("list-page-1", "list concepts", "returns a page and says how to get the next", T.list, { folder: "_fixtures/temporal", include_expired: true, limit: 2 }, (v) => {
    ok(v);
    has(v, "More: call again with offset 2.");
  }),
  directed("list-page-2", "list concepts", "returns the next page", T.list, { folder: "_fixtures/temporal", include_expired: true, limit: 2, offset: 2, response_format: "json" }, (v) => {
    ok(v);
    const d = json(v);
    v.check("the page starts where asked", d.offset === 2 && d.count === 2, [d.offset, d.count]);
    v.check("the total is the whole folder", d.total_count === 6, d.total_count);
  }),
  directed("list-relationship-count", "list concepts", "filters by how many relationships of a kind a concept has", T.list, { folder: "semantic", relationship: { type: "derived-from", direction: "outgoing", min: 1 } }, (v) => {
    ok(v);
    has(v, "API Rate Limit Policy");
  }),
  directed("list-bad-bundle", "list concepts", "refuses a bundle the vault does not have", T.list, { bundle: "nope" }, (v) => {
    refused(v);
    has(v, 'No bundle "nope"');
  }),
  directed("list-stray-argument", "list concepts", "a misspelt filter is refused, not answered unfiltered", T.list, { bundel: "semantic" }, (v) => {
    refused(v);
    has(v, "bundel");
  }),
  directed("list-unknown-type", "list concepts", "names the vault's values when a filter matches nothing it has", T.list, { entity_type: "zzz-not-a-type" }, (v) => refused(v)),

  directed("entities-grouped", "entities", "counts entities by type", T.entities, { group_by_type: true }, (v) => ok(v)),
  directed("entity-types-core", "entities", "lists the core entity types", T.types, { source: "core" }, (v) => {
    ok(v);
    has(v, "5 entity type(s).", 'Person (urn segment "person") — core');
  }),
  directed("entity-types-bad-bundle", "entities", "refuses a bundle the vault does not have", T.types, { bundle: "nope" }, (v) => refused(v)),

  directed("status-graph", "status", "reports the graph's size and health", T.status, {}, (v) => {
    ok(v);
    has(v, /\d+ concept\(s\) in 1 bundle\(s\)/, "Freshness:", "Trust:");
  }),
  directed("status-store", "status", "reports the vector store's coverage", T.status, { report: "store" }, (v) => {
    ok(v);
    has(v, /Bundle "": \d+ document\(s\) stored/);
  }),
  directed("status-gaps", "status", "runs the relationship gap report on the request", T.status, { report: "gaps" }, (v) => {
    ok(v);
    has(v, /Compared \d+ ingested concept\(s\)/);
    v.check("it is not a task: this client does not declare the extension on the call", v.call.result?.resultType !== "task" || !!v.traffic.capsOf(v.call)?.extensions?.[TASKS]);
    v.fact("declares the Tasks extension on the tool call", !!v.traffic.capsOf(v.call)?.extensions?.[TASKS]);
  }),
  directed("status-json", "status", "returns the data as JSON text for a program", T.status, { response_format: "json" }, (v) => {
    ok(v);
    const d = json(v);
    v.check("the report is there", d.report === "graph" && typeof d.graph?.concepts === "number" && typeof d.graph?.awaiting_review === "number", Object.keys(d.graph ?? {}));
    v.check("no structured copy is sent beside it", v.call.result?.structuredContent === undefined);
  }),

  // ======================================================================================
  // read tools, agent: does the model find its way, and does it weigh what it reads
  // ======================================================================================
  {
    id: "agent-title-lookup",
    area: "agent reads",
    what: "finds a concept by its title, reports the fact and how far to rely on it",
    repeat: 3,
    input: "Using the mif vault tools, how many requests per minute does the API Rate Limit Policy allow per key? Answer with the number, and say in one sentence how far the vault says it can be relied on.",
    verify({ traffic, answer, check, fact }) {
      check("a vault tool was called", traffic.tools().length > 0);
      check("the fact is right", /\b600\b/.test(answer), answer);
      check("the answer reports the vault's own weighing", /timeless|trust|provenance|not recorded|no (validity|expiry|date)|level 1/i.test(answer), answer);
      fact("tools called", traffic.tools());
      fact("went straight to the concept, without a search", traffic.tools()[0] === T.get);
    },
  },
  {
    id: "agent-incoming",
    area: "agent reads",
    what: "follows relationships that other concepts declare",
    repeat: 3,
    input: "Using the mif vault tools, which concepts declare a relationship to the API Rate Limit Policy? Give their titles.",
    verify({ traffic, answer, check }) {
      check("the relationships tool was called", traffic.tools().includes(T.rel), traffic.tools().join(","));
      check("names the runbook", /Rotate API Keys/i.test(answer), answer);
      // It may mention the incident while explaining the difference; what it must not do is list it as declaring one.
      check("says only one concept does", /\b(only|one|1|single)\b/i.test(answer), answer);
    },
  },
  {
    id: "agent-expired",
    area: "agent reads",
    what: "treats an expired concept as history, not as current fact",
    repeat: 3,
    input: 'Using the mif vault tools, read the concept titled "Expired policy (validUntil)". Is what it says in force today? Start your answer with YES or NO.',
    verify({ traffic, answer, check }) {
      check("the concept was read", traffic.tools().includes(T.get), traffic.tools().join(","));
      check("the answer is no", /^\W*NO\b/i.test(answer.trim()), answer.slice(0, 200));
      check("it says the concept has expired", /expired/i.test(answer), answer.slice(0, 300));
    },
  },
  {
    id: "agent-result-text",
    area: "agent reads",
    what: "the model receives a tool's text, which carries the weighing and the next steps",
    repeat: 3,
    input: "Call the mif vault's status tool exactly once with no arguments. Then quote, verbatim and in a code block, the first two lines of what you received back, exactly as you received them.",
    verify({ traffic, answer, check }) {
      const call = traffic.of("tools/call", T.status)[0];
      check("the status tool was called", !!call);
      const text = call ? traffic.text(call) : "";
      check("the server sent text and no structured copy", text.length > 0 && call?.result?.structuredContent === undefined);
      check("the model saw the text", answer.includes(text.split("\n")[0].slice(0, 40)), answer.slice(0, 300));
    },
  },
  {
    id: "agent-recall",
    area: "agent reads",
    what: "the recall prompt, run as typed, ends in a cited answer",
    repeat: 3,
    input: prompt("mif_vault_recall", '"rate limits"'),
    verify({ traffic, answer, check }) {
      check("the prompt was requested", !!traffic.prompt("mif_vault_recall"));
      check("vault tools were used", traffic.tools().length > 0, traffic.tools().join(","));
      check("the answer has the limit", /\b600\b/.test(answer), answer.slice(0, 300));
      check("it names the concept it came from", /rate-limit-policy\.md|API Rate Limit Policy/.test(answer), answer.slice(0, 300));
      check("it says how far to rely on it", /timeless|trust|provenance|unverified|not recorded|level 1/i.test(answer), answer.slice(-600));
    },
  },
  {
    id: "agent-consolidate",
    area: "agent reads",
    what: "the consolidate prompt takes the whole typed topic and waits for the user before writing",
    repeat: 3,
    input: prompt("mif_vault_consolidate", "rate limiting incidents"),
    verify({ traffic, answer, check }) {
      check("the prompt was requested", !!traffic.prompt("mif_vault_consolidate"));
      check("it works from the incident record", /Rate Spike Incident|incident-2026-01/i.test(answer), answer.slice(0, 400));
      check("nothing is written before the user agrees", !traffic.tools().includes(T.write), traffic.tools().join(","));
    },
  },

  // ======================================================================================
  // writes, directed: every operation, with the vault checked afterwards. In order.
  // ======================================================================================
  directed(
    "ingest",
    "writes",
    "brings the vector store up to date",
    T.ingest,
    {},
    (v) => {
      ok(v);
      has(v, /Bundle "": \d+ concept\(s\) embedded, \d+ already current, \d+ refused\./);
    },
    { stage: "setup" },
  ),
  directed(
    "create",
    "writes",
    "creates a concept whole: linked, cited, marked agent-written and unverified",
    T.write,
    { operation: "create", title: "Eval Probe Alpha", type: "semantic", body: "A probe written by an evaluation.", on_duplicate: "create", relationships: [{ type: "relates-to", target: POLICY }], citations: [{ title: "Probe source", url: "https://example.test/probe" }] },
    (v) => {
      ok(v);
      has(v, `Created Eval Probe Alpha [${ALPHA}].`, "trust: uncertain");
      const text = v.note(ALPHA) ?? "";
      v.check("the note exists, named with the title's capitals", text.length > 0);
      v.check("marked agent-written and unverified", /sourceType: agent_inferred/.test(text) && /trustLevel: uncertain/.test(text));
      const name = v.traffic.clientInfo()?.name;
      v.check("the client is on record", !!name && text.includes(`agent: ${name}`), /agent: .*/.exec(text)?.[0]);
      v.check("the relationship is in the frontmatter and mirrored", text.includes("target: /semantic/rate-limit-policy.md") && text.includes("- relates-to [API Rate Limit Policy](/semantic/rate-limit-policy.md)"), text.slice(-400));
      v.check("the citation is in the frontmatter and mirrored", text.includes("url: https://example.test/probe") && text.includes("[Probe source](https://example.test/probe)"));
      v.check("the body is the text given", text.includes("A probe written by an evaluation."));
    },
    { writes: true },
  ),
  directed(
    "create-no-type",
    "writes",
    "refuses a new concept with no type, and writes nothing",
    T.write,
    { operation: "create", title: "Eval Probe Untyped", body: "x" },
    (v) => {
      refused(v);
      v.check("nothing was written", v.note("semantic/Eval-Probe-Untyped.md") === undefined && v.note("Eval-Probe-Untyped.md") === undefined);
    },
    { writes: true },
  ),
  directed(
    "create-bad-target",
    "writes",
    "refuses a concept that declares a relationship to nothing, and writes nothing",
    T.write,
    { operation: "create", title: "Eval Probe Dangling", type: "semantic", body: "x", on_duplicate: "create", relationships: [{ type: "relates-to", target: "No Such Concept Anywhere" }] },
    (v) => {
      refused(v);
      v.check("nothing was written", v.note("semantic/Eval-Probe-Dangling.md") === undefined);
    },
    { writes: true },
  ),
  directed(
    "create-duplicate-cancel",
    "writes",
    "a near-duplicate with the choice 'cancel' writes nothing",
    T.write,
    { operation: "create", title: "API gateway rate limit policy", type: "semantic", body: "The public API gateway allows 600 requests per minute per API key.", summary: "The API gateway rate limit per key.", on_duplicate: "cancel" },
    (v) => {
      ok(v);
      has(v, "Nothing was written: the vault already holds");
      v.check("nothing was written", v.note("semantic/API-gateway-rate-limit-policy.md") === undefined);
    },
    { writes: true },
  ),
  directed(
    "create-duplicate-asks",
    "writes",
    "a near-duplicate with no choice given asks the user, and writes nothing unanswered",
    T.write,
    { operation: "create", title: "API gateway rate limit policy", type: "semantic", body: "The public API gateway allows 600 requests per minute per API key.", summary: "The API gateway rate limit per key." },
    (v) => {
      // The first answer on the wire is the question; with no one to answer, the client reports that back.
      const calls = v.traffic.of("tools/call", T.write);
      v.check("the server asked by elicitation", calls.some((c) => c.result?.resultType === "input_required"), calls.map((c) => c.result?.resultType ?? (c.result?.isError ? "error" : "result")));
      v.check("nothing was written", v.note("semantic/API-gateway-rate-limit-policy.md") === undefined);
    },
    { writes: true },
  ),
  directed(
    "create-second",
    "writes",
    "creates a second concept, for the merge",
    T.write,
    { operation: "create", title: "Eval Probe Beta", type: "semantic", body: "A second probe.", on_duplicate: "create", relationships: [{ type: "relates-to", target: RUNBOOK }] },
    (v) => {
      ok(v);
      v.check("the note exists", (v.note(BETA) ?? "").includes("A second probe."));
    },
    { writes: true },
  ),
  directed(
    "edit-summary",
    "writes",
    "edits a summary and nothing else",
    T.edit,
    { operation: "edit", concept: "Eval Probe Alpha", summary: "A probe." },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("the summary is set", /summary: A probe\./.test(text), text.slice(0, 300));
      v.check("the body is unchanged", text.includes("A probe written by an evaluation."));
      v.check("still unverified, and a modified time is recorded", /trustLevel: uncertain/.test(text) && /modified: /.test(text));
    },
    { writes: true },
  ),
  directed(
    "edit-section",
    "writes",
    "adds a section and keeps the mirrored sections",
    T.edit,
    { operation: "edit", concept: "Eval Probe Alpha", section: "Notes", text: "Added by the evaluation." },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("the section is there", text.includes("## Notes\n\nAdded by the evaluation."), text.slice(-500));
      v.check("the rest of the text is unchanged", text.includes("A probe written by an evaluation."));
      v.check("the mirrored sections follow it", text.indexOf("## Notes") < text.indexOf("## Citations") && text.includes("## Relationships"));
    },
    { writes: true },
  ),
  directed(
    "edit-mirrored-refused",
    "writes",
    "refuses to write a section the plugin maintains",
    T.edit,
    { operation: "edit", concept: "Eval Probe Alpha", section: "Relationships", text: "- relates-to [Nothing](/nothing.md)" },
    (v) => {
      refused(v);
      v.check("the note is unchanged", !(v.note(ALPHA) ?? "").includes("nothing.md"));
    },
    { writes: true },
  ),
  directed(
    "relationship-add",
    "writes",
    "adds a typed relationship with a strength, in the frontmatter and its mirror",
    T.wrel,
    { operation: "add", from: "Eval Probe Alpha", target: INCIDENT, type: "derived-from", strength: 0.5 },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("in the frontmatter", /type: derived-from\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md\n\s+strength: 0\.5/.test(text), text.slice(0, 900));
      v.check("mirrored", text.includes("- derived-from [Rate Spike Incident 2026-01](/episodic/incident-2026-01-rate-spike.md)"));
    },
    { writes: true },
  ),
  directed("relationship-add-twice", "writes", "refuses a relationship the concept already declares", T.wrel, { operation: "add", from: "Eval Probe Alpha", target: INCIDENT, type: "derived-from" }, (v) => refused(v), { writes: true }),
  directed("relationship-self", "writes", "refuses a relationship from a concept to itself", T.wrel, { operation: "add", from: "Eval Probe Alpha", target: ALPHA, type: "relates-to" }, (v) => refused(v), { writes: true }),
  directed(
    "relationship-update-unagreed",
    "writes",
    "changing a relationship asks the user, and changes nothing unanswered",
    T.wrel,
    { operation: "update", from: "Eval Probe Alpha", target: INCIDENT, type: "derived-from", new_type: "relates-to" },
    (v) => {
      v.check("the server asked by elicitation", v.traffic.of("tools/call", T.wrel).some((c) => c.result?.resultType === "input_required"));
      v.check("the relationship is unchanged", /type: derived-from\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md/.test(v.note(ALPHA) ?? ""));
    },
    { writes: true },
  ),
  directed(
    "relationship-update",
    "writes",
    "changes a relationship's type and strength once agreed",
    T.wrel,
    { operation: "update", from: "Eval Probe Alpha", target: INCIDENT, type: "derived-from", new_type: "relates-to", strength: 0.9, confirm: true },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("the type and strength changed", /type: relates-to\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md\n\s+strength: 0\.9/.test(text), text.slice(0, 900));
      v.check("the mirror follows", text.includes("- relates-to [Rate Spike Incident 2026-01]") && !text.includes("- derived-from [Rate Spike Incident 2026-01]"));
    },
    { writes: true },
  ),
  directed(
    "relationship-remove",
    "writes",
    "removes a relationship once agreed",
    T.wrel,
    { operation: "remove", from: "Eval Probe Alpha", target: INCIDENT, type: "relates-to", confirm: true },
    (v) => {
      ok(v);
      v.check("it is gone from the frontmatter and the mirror", !(v.note(ALPHA) ?? "").includes("incident-2026-01-rate-spike.md"));
    },
    { writes: true },
  ),
  directed(
    "citation-add",
    "writes",
    "adds a citation in the frontmatter and its mirror",
    T.wref,
    { operation: "add_citation", concept: "Eval Probe Alpha", citation: { title: "Second source", url: "https://example.test/second", type: "article" } },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("in the frontmatter, with its type and an access date", /title: Second source\n\s+url: https:\/\/example\.test\/second\n\s+accessed: \d{4}-\d\d-\d\d/.test(text) && text.includes("citationType: article"), text.slice(0, 1200));
      v.check("mirrored", text.includes("[Second source](https://example.test/second)"));
    },
    { writes: true },
  ),
  directed(
    "citation-no-url",
    "writes",
    "refuses a citation with no url, which MIF requires",
    T.wref,
    { operation: "add_citation", concept: "Eval Probe Alpha", citation: { title: "No address" } },
    (v) => {
      refused(v);
      v.check("the note is unchanged", !(v.note(ALPHA) ?? "").includes("No address"));
    },
    { writes: true },
  ),
  directed("entity-unknown-type", "writes", "refuses an entity type the vault does not have, and names the ones it has", T.wref, { operation: "create_entity", entity: { name: "Eval Probe Box", type: "appliance" } }, (v) => {
    refused(v);
    has(v, "is not an entity type of this bundle", "Person", T.types);
  }, { writes: true }),
  directed("entity-create", "writes", "records an entity of a core type", T.wref, { operation: "create_entity", entity: { name: PERSON, type: "Person" } }, (v) => {
    ok(v);
    has(v, `Recorded the entity ${PERSON} as urn:mif:entity:person:${PERSON_SLUG}.`);
    v.check("the record is on disk", v.note(`.mif/entities/person/${PERSON_SLUG}.yaml`)?.includes(PERSON));
  }, { writes: true }),
  directed(
    "entity-reference",
    "writes",
    "adds an entity reference, finding the entity by name",
    T.wref,
    { operation: "add_entity_reference", concept: "Eval Probe Alpha", entity: { name: PERSON, role: "author" } },
    (v) => {
      ok(v);
      const text = v.note(ALPHA) ?? "";
      v.check("the reference is in the frontmatter with its role", text.includes(`"@id": urn:mif:entity:person:${PERSON_SLUG}`) && /role: author/.test(text), text.slice(0, 1400));
    },
    { writes: true },
  ),
  directed(
    "merge",
    "writes",
    "merges one concept into another: text, relationships, and the merged one kept but ended",
    T.edit,
    { operation: "merge", concept: "Eval Probe Alpha", merge_from: ["Eval Probe Beta"], body: "Alpha and Beta, merged by the evaluation." },
    (v) => {
      ok(v);
      const alpha = v.note(ALPHA) ?? "";
      const beta = v.note(BETA) ?? "";
      v.check("the survivor has the merged text", alpha.includes("Alpha and Beta, merged by the evaluation.") && !alpha.includes("A probe written by an evaluation."));
      v.check("it took over what the other declared", alpha.includes("target: /procedural/rotate-api-keys.md"), alpha.slice(0, 1200));
      v.check("it supersedes the other", /type: supersedes\n\s+target: \/semantic\/Eval-Probe-Beta\.md/.test(alpha));
      v.check("the merged concept is kept, with its validity ended", /validUntil: \d{4}/.test(beta) && beta.includes("A second probe."));
    },
    { writes: true },
  ),
  directed(
    "supersede-unagreed",
    "writes",
    "superseding asks the user, and writes nothing unanswered",
    T.write,
    { operation: "supersede", supersedes: "Eval Probe Alpha", title: "Eval Probe Gamma", body: "Replaces Alpha." },
    (v) => {
      v.check("the server asked by elicitation", v.traffic.of("tools/call", T.write).some((c) => c.result?.resultType === "input_required"));
      v.check("nothing was written", v.note(GAMMA) === undefined && !/validUntil/.test(v.note(ALPHA) ?? ""));
    },
    { writes: true },
  ),
  directed(
    "supersede",
    "writes",
    "supersedes once agreed: the old concept is kept and ended, the new one takes over its relationships",
    T.write,
    { operation: "supersede", supersedes: "Eval Probe Alpha", title: "Eval Probe Gamma", body: "Replaces Alpha.", confirm: true },
    (v) => {
      ok(v);
      const gamma = v.note(GAMMA) ?? "";
      const alpha = v.note(ALPHA) ?? "";
      v.check("the new concept exists", gamma.includes("Replaces Alpha."));
      v.check("it supersedes the old one", /type: supersedes\n\s+target: \.?\/?Eval-Probe-Alpha\.md|type: supersedes\n\s+target: \/semantic\/Eval-Probe-Alpha\.md/.test(gamma), gamma.slice(0, 900));
      v.check("it took over the old one's relationships", gamma.includes("rate-limit-policy.md") && gamma.includes("rotate-api-keys.md"), gamma.slice(0, 1200));
      v.check("the old one is kept, with its validity ended", /validUntil: \d{4}/.test(alpha) && alpha.includes("Alpha and Beta, merged"));
      v.check("the new one is agent-written and unverified", /sourceType: agent_inferred/.test(gamma) && /trustLevel: uncertain/.test(gamma));
    },
    { writes: true },
  ),
  directed(
    "status-after-writes",
    "writes",
    "the graph report counts what waits for review",
    T.status,
    { response_format: "json" },
    (v) => {
      ok(v);
      const d = json(v);
      v.check("the agent-written concepts are counted as awaiting review", d.graph?.awaiting_review >= 3, d.graph?.awaiting_review);
    },
    { writes: true },
  ),

  // ---- a note that is being edited is left alone ------------------------------------------
  directed(
    "busy-active-editor",
    "writes",
    "refuses to change the note that is open in the active editor, and says to try again",
    T.wref,
    { operation: "add_citation", concept: RUNBOOK, citation: { title: "Busy probe", url: "https://example.test/busy" } },
    (v) => {
      refused(v);
      has(v, "is open in Obsidian with unsaved edits, or is the note being edited now", "try again");
      v.check("the note is unchanged", !(v.note(RUNBOOK) ?? "").includes("Busy probe"));
    },
    { writes: true, before: (ctl) => ctl.openEditor(RUNBOOK), after: (ctl) => ctl.closeEditors() },
  ),
  directed(
    "busy-unsaved-edits",
    "writes",
    "refuses to change a note that has unsaved edits in an editor that is not the active one",
    T.wrel,
    { operation: "add", from: RUNBOOK, target: INCIDENT, type: "relates-to" },
    (v) => {
      refused(v);
      has(v, "unsaved edits");
      v.check("the note is unchanged", !(v.note(RUNBOOK) ?? "").includes("incident-2026-01-rate-spike.md"));
    },
    // Only the in-memory vault can hold text in an editor that is not on disk.
    { writes: true, server: "memory", before: (ctl) => ctl.openEditor(RUNBOOK, "typed but not saved"), after: (ctl) => ctl.closeEditors() },
  ),
  directed(
    "busy-released",
    "writes",
    "the same change goes through once the note is no longer being edited",
    T.wref,
    { operation: "add_citation", concept: RUNBOOK, citation: { title: "Busy probe", url: "https://example.test/busy" } },
    (v) => {
      ok(v);
      v.check("the citation was written", (v.note(RUNBOOK) ?? "").includes("https://example.test/busy"));
    },
    { writes: true },
  ),

  // ---- the user answers: a Claude Code hook answers the server's question as the case says ----
  directed(
    "answer-type-chosen",
    "writes",
    "a relationship with no type is written with the type the user picks",
    T.wrel,
    { operation: "add", from: "Eval Probe Gamma", target: INCIDENT },
    (v) => {
      const calls = v.traffic.of("tools/call", T.wrel);
      v.check("the server asked, then got the answer", calls.some((c) => c.result?.resultType === "input_required") && calls.some((c) => !c.result?.isError && c.result?.resultType !== "input_required"), calls.map((c) => c.result?.resultType ?? (c.result?.isError ? `error: ${v.traffic.text(c).slice(0, 80)}` : "result")));
      v.check("the relationship has the chosen type", /type: derived-from\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md/.test(v.note(GAMMA) ?? ""), (v.note(GAMMA) ?? "").slice(0, 900));
      if (v.elicitations.length) {
        const q = v.elicitations[0];
        v.check("the question names both concepts", /Eval Probe Gamma/.test(q.message ?? "") && /Rate Spike Incident/.test(q.message ?? ""), q.message);
        v.check("the form offers the vault's relationship types", JSON.stringify(q.schema ?? {}).includes("derived-from"), q.schema);
      }
      v.fact("questions the hook saw", v.elicitations.length);
    },
    { writes: true, answer: { choice: "derived-from" } },
  ),
  directed(
    "answer-removal-declined",
    "writes",
    "a removal the user says no to is not made",
    T.wrel,
    { operation: "remove", from: "Eval Probe Gamma", target: INCIDENT, type: "derived-from" },
    (v) => {
      v.check("the server asked", v.traffic.of("tools/call", T.wrel).some((c) => c.result?.resultType === "input_required"));
      v.check("the relationship is still there", (v.note(GAMMA) ?? "").includes("incident-2026-01-rate-spike.md"));
    },
    { writes: true, answer: { confirm: false } },
  ),
  directed(
    "answer-removal-agreed",
    "writes",
    "a removal the user agrees to is made",
    T.wrel,
    { operation: "remove", from: "Eval Probe Gamma", target: INCIDENT, type: "derived-from" },
    (v) => {
      const calls = v.traffic.of("tools/call", T.wrel);
      v.check("the server asked, then got the answer", calls.some((c) => c.result?.resultType === "input_required") && calls.some((c) => !c.result?.isError && c.result?.resultType !== "input_required"), calls.map((c) => c.result?.resultType ?? (c.result?.isError ? `error: ${v.traffic.text(c).slice(0, 80)}` : "result")));
      v.check("the relationship is gone", !(v.note(GAMMA) ?? "").includes("incident-2026-01-rate-spike.md"));
      if (v.elicitations.length) v.check("the question says what will be removed", /Remove the derived-from relationship/.test(v.elicitations[0].message ?? ""), v.elicitations[0].message);
    },
    { writes: true, answer: { confirm: true } },
  ),
  directed(
    "answer-supersede-agreed",
    "writes",
    "a supersession the user agrees to is made",
    T.write,
    { operation: "supersede", supersedes: "Eval Probe Gamma", title: "Eval Probe Delta", body: "Replaces Gamma." },
    (v) => {
      v.check("the server asked", v.traffic.of("tools/call", T.write).some((c) => c.result?.resultType === "input_required"));
      v.check("the new concept exists and the old one is ended", (v.note(DELTA) ?? "").includes("Replaces Gamma.") && /validUntil: \d{4}/.test(v.note(GAMMA) ?? ""), [!!v.note(DELTA), /validUntil/.test(v.note(GAMMA) ?? "")]);
    },
    { writes: true, answer: { confirm: true } },
  ),
  directed(
    "create-duplicate-answered",
    "writes",
    "a near-duplicate the user chooses to keep both of is written",
    T.write,
    { operation: "create", title: "API gateway rate limit policy", type: "semantic", body: "The public API gateway allows 600 requests per minute per API key.", summary: "The API gateway rate limit per key." },
    (v) => {
      v.check("the server asked", v.traffic.of("tools/call", T.write).some((c) => c.result?.resultType === "input_required"));
      v.check("the concept was written", v.note("semantic/API-gateway-rate-limit-policy.md") !== undefined);
      if (v.elicitations.length) v.check("the question names the concept it is close to", /API Rate Limit Policy/.test(v.elicitations[0].message ?? ""), v.elicitations[0].message);
    },
    { writes: true, answer: { choice: "create" } },
  ),

  // ---- notifications: what goes down the client's change subscription, and what it does next ----
  {
    id: "notify-resource-created",
    area: "notifications",
    what: "a concept created while a client listens is announced on its subscription",
    writes: true,
    input: "Using the mif vault tools, call mif_vault_get_status once with no arguments, then call mif_vault_list_entity_types once with no arguments, then reply with the single word DONE.",
    during: (ctl) => ctl.create(NOTICE, noticeNote),
    verify({ traffic, note, check, fact }) {
      const listen = traffic.of("subscriptions/listen")[0];
      check("the client opened a change subscription", !!listen);
      check("the note was created", note(NOTICE) !== undefined);
      const filter = listen?.params?.notifications ?? {};
      const events = traffic.events().map((e) => e.method);
      // A client is told only what it asked to hear.
      check("resources/list_changed was sent if the client asked for it", !filter.resourcesListChanged || events.includes("notifications/resources/list_changed"), { filter, events });
      fact("what the client asked to hear", filter);
      fact("what the server sent", events);
    },
  },
  {
    id: "notify-writes-switched",
    area: "notifications",
    what: "switching writes off mid-session is announced, and Claude Code asks for the tool list again",
    writes: true,
    server: "memory",
    input: "Using the mif vault tools, call mif_vault_get_status once with no arguments, then call mif_vault_list_entity_types once with no arguments, then call mif_vault_get_status once more, then reply with the single word DONE.",
    during: (ctl) => ctl.set({ mcpAllowWrites: false }),
    after: (ctl) => ctl.set({ mcpAllowWrites: true }),
    verify({ traffic, check, fact }) {
      const filter = traffic.of("subscriptions/listen")[0]?.params?.notifications ?? {};
      const events = traffic.events();
      const told = events.find((e) => e.method === "notifications/tools/list_changed");
      check("tools/list_changed was sent if the client asked for it", !filter.toolsListChanged || !!told, { filter, events: events.map((e) => e.method) });
      const lists = traffic.of("tools/list");
      const again = told ? lists.find((t) => t.at >= told.at) : undefined;
      // Claude Code's documentation says a headless session refreshes its tool list on this notice.
      check("the client asked for the tool list again", !told || !!again, lists.map((t) => t.at - (told?.at ?? 0)));
      check("the new list has only the read tools", !again || (again.result?.tools ?? []).length === 7, (again?.result?.tools ?? []).map((t) => t.name));
      fact("prompts/list_changed was sent", events.some((e) => e.method === "notifications/prompts/list_changed"));
      fact("the client asked for the prompt list again", !!told && traffic.of("prompts/list").some((t) => t.at >= told.at));
    },
  },

  // ======================================================================================
  // writes, agent: the guards, and a prompt carried through to a write
  // ======================================================================================
  {
    id: "agent-choice",
    area: "agent writes",
    what: "a relationship with no type is not written until someone chooses the type",
    writes: true,
    repeat: 3,
    input: "Using the mif vault tools, add a relationship from the Rate Spike Incident 2026-01 to the Rotate API Keys runbook. Do not choose a relationship type yourself and do not pass one: that choice is mine, and I have not made it.",
    verify({ traffic, note, check, fact }) {
      const calls = traffic.of("tools/call", T.wrel);
      check("the relationship tool was called", calls.length > 0, traffic.tools().join(","));
      check("nothing was written", !(note(INCIDENT) ?? "").includes("rotate-api-keys.md"));
      check("the model did not pass a type of its own", !calls.some((c) => typeof c.params?.arguments?.type === "string" && c.params.arguments.type));
      fact("the server asked by elicitation", calls.some((c) => c.result?.resultType === "input_required"));
    },
  },
  {
    id: "agent-confirm",
    area: "agent writes",
    what: "a removal is not made without the user's agreement",
    writes: true,
    repeat: 3,
    input: "Using the mif vault tools, try to remove the relates-to relationship that the Rotate API Keys runbook declares to the API Rate Limit Policy. I have NOT agreed to this removal: do not claim that I have, and stop if the tool needs my agreement.",
    verify({ traffic, note, check, fact }) {
      const calls = traffic.of("tools/call", T.wrel);
      check("the relationship tool was called", calls.length > 0, traffic.tools().join(","));
      check("the relationship is still there", (note(RUNBOOK) ?? "").includes("/semantic/rate-limit-policy.md"));
      check("the model did not claim agreement", !calls.some((c) => c.params?.arguments?.confirm === true));
      fact("the server asked by elicitation", calls.some((c) => c.result?.resultType === "input_required"));
    },
  },
  {
    id: "agent-capture",
    area: "agent writes",
    what: "the capture prompt, cut short by the client, still tries to write the whole of what was typed",
    writes: true,
    repeat: 3,
    input: prompt("mif_vault_capture", '"The on-call rota for the API gateway changes every Monday at 09:00 UTC"'),
    verify({ traffic, answer, check, fact }) {
      const p = traffic.prompt("mif_vault_capture");
      check("the prompt was requested", !!p);
      const writes = traffic.of("tools/call", T.write);
      const sent = writes.map((c) => `${c.params?.arguments?.title ?? ""}\n${c.params?.arguments?.body ?? ""}\n${c.params?.arguments?.summary ?? ""}`).join("\n");
      const whole = (t) => /Monday/i.test(t) && /09:00|9:00|9 ?am/i.test(t) && /rota/i.test(t);
      // The prompt's first step is to check what the vault already holds and stop if it is there. A repeat of
      // this case finds the concept an earlier run wrote, so stopping with the whole fact in hand is right too.
      const found = writes.length === 0 && /already/i.test(answer) && whole(answer);
      check("it wrote the whole of what was typed, or found it already in the vault and stopped", (writes.length > 0 && whole(sent)) || found, (sent || answer).slice(0, 400));
      fact("found it already there", found);
      fact("the client passed the whole sentence", p?.text.includes("changes every Monday"));
      fact("saved", writes.some((c) => traffic.text(c).startsWith("Created ")));
    },
  },

  // ======================================================================================
  // a vault with writes off: run with --mode writes-off
  // ======================================================================================
  {
    id: "off-lists",
    area: "writes off",
    mode: "writes-off",
    what: "offers the seven read tools and two prompts, and nothing that writes",
    tools: false,
    input: "Reply with the single word: ready",
    verify({ traffic, check }) {
      const tools = (traffic.of("tools/list")[0]?.result?.tools ?? []).map((t) => t.name);
      check("seven tools", tools.length === 7, tools);
      check("none of them writes", !tools.some((n) => /write|edit|ingest/.test(n)), tools);
      check("every one is marked read-only", (traffic.of("tools/list")[0]?.result?.tools ?? []).every((t) => t.annotations?.readOnlyHint === true));
      const prompts = (traffic.of("prompts/list")[0]?.result?.prompts ?? []).map((p) => p.name);
      check("only the guide and recall prompts", JSON.stringify(prompts) === JSON.stringify(["mif_vault_guide", "mif_vault_recall"]), prompts);
    },
  },
  {
    id: "off-guide",
    area: "writes off",
    mode: "writes-off",
    what: "the guide says the vault does not allow writes",
    tools: false,
    input: prompt("mif_vault_guide"),
    verify({ traffic, check }) {
      check("it says so", traffic.prompt("mif_vault_guide")?.text.includes("This vault does not allow writes"), traffic.prompt("mif_vault_guide")?.text.slice(-400));
    },
  },
  {
    ...directed("off-read", "writes off", "reads still work", T.get, { concept: POLICY }, (v) => {
      ok(v);
      has(v, "600");
    }),
    mode: "writes-off",
  },
  {
    id: "off-write-attempt",
    area: "writes off",
    mode: "writes-off",
    what: "an agent asked to write cannot, and nothing changes",
    repeat: 3,
    input: 'Using the mif vault tools, create a semantic concept titled "Eval Probe Off" with the body "Should not exist." If you have no tool that can do this, say NO WRITE TOOL.',
    verify({ traffic, note, check }) {
      check("no write call succeeded", !traffic.of("tools/call").some((c) => /write|edit/.test(c.params?.name ?? "") && !c.error && c.result?.isError !== true), traffic.tools().join(","));
      check("nothing was written", note("semantic/Eval-Probe-Off.md") === undefined);
    },
  },

  // ======================================================================================
  // a vault whose write limit is three: run with --mode limit
  // ======================================================================================
  ...[1, 2, 3].map((n) => ({
    ...directed(
      `limit-write-${n}`,
      "write limit",
      `write ${n} of 3 is admitted`,
      T.wref,
      { operation: "add_citation", concept: RUNBOOK, citation: { title: `Limit probe ${n}`, url: `https://example.test/limit-${n}` } },
      (v) => {
        ok(v);
        v.check("the citation was written", (v.note(RUNBOOK) ?? "").includes(`https://example.test/limit-${n}`));
      },
      { writes: true },
    ),
    mode: "limit",
  })),
  {
    ...directed(
      "limit-write-4",
      "write limit",
      "the fourth write in the window is refused, with when to try again",
      T.wref,
      { operation: "add_citation", concept: RUNBOOK, citation: { title: "Limit probe 4", url: "https://example.test/limit-4" } },
      (v) => {
        refused(v);
        has(v, "This vault allows 3 writes in 10 minutes and that many have been made.", /Try again in about \d+ minute/);
        v.check("nothing was written", !(v.note(RUNBOOK) ?? "").includes("limit-4"));
      },
      { writes: true },
    ),
    mode: "limit",
  },
  {
    ...directed(
      "limit-read-still-works",
      "write limit",
      "reads are not limited",
      T.get,
      { concept: RUNBOOK, include: ["citations"] },
      (v) => {
        ok(v);
        has(v, "Limit probe 3");
        lacks(v, "Limit probe 4");
      },
      { writes: true },
    ),
    mode: "limit",
  },

  // ======================================================================================
  // a vault with two bundles: run with --mode bundles
  // ======================================================================================
  {
    ...directed("bundles-status", "bundles", "the graph report covers both bundles, or one on request", T.status, { bundle: "_fixtures/rel", response_format: "json" }, (v) => {
      ok(v);
      const d = json(v);
      v.check("only the bundle asked for is reported", JSON.stringify(d.graph?.bundles) === JSON.stringify(["_fixtures/rel"]) && d.graph?.concepts === 5, [d.graph?.bundles, d.graph?.concepts]);
    }),
    mode: "bundles",
  },
  {
    ...directed("bundles-list", "bundles", "a list keeps to one bundle", T.list, { bundle: "_fixtures/rel", response_format: "json" }, (v) => {
      ok(v);
      const d = json(v);
      v.check("five concepts, all of that bundle", d.total_count === 5 && (d.concepts ?? []).every((c) => c.path.startsWith("_fixtures/rel/")), [d.total_count, (d.concepts ?? []).map((c) => c.path)]);
    }),
    mode: "bundles",
  },
  {
    ...directed("bundles-gaps-needs-one", "bundles", "the gap report asks which bundle when there are several", T.status, { report: "gaps" }, (v) => {
      refused(v);
      has(v, "The gap report compares one bundle at a time.", '"_fixtures/rel"');
    }),
    mode: "bundles",
  },
  {
    ...directed(
      "bundles-create-needs-one",
      "bundles",
      "a new concept is refused until the bundle is named",
      T.write,
      { operation: "create", title: "Eval Probe Nowhere", type: "semantic", body: "x", on_duplicate: "create" },
      (v) => {
        refused(v);
        has(v, "This vault has several bundles; say which with bundle:");
      },
      { writes: true, server: "memory" },
    ),
    mode: "bundles",
  },
  {
    ...directed(
      "bundles-create",
      "bundles",
      "a new concept goes into the bundle named",
      T.write,
      { operation: "create", title: "Eval Probe Rel", type: "semantic", body: "In the second bundle.", bundle: "_fixtures/rel", on_duplicate: "create" },
      (v) => {
        ok(v);
        v.check("the note is under that bundle's folder", (v.note("_fixtures/rel/semantic/Eval-Probe-Rel.md") ?? "").includes("In the second bundle."));
      },
      { writes: true, server: "memory" },
    ),
    mode: "bundles",
  },
  {
    ...directed(
      "bundles-cross-relationship",
      "bundles",
      "a relationship to a concept in another bundle names it by its id, not by a path",
      T.wrel,
      { operation: "add", from: "Eval Probe Rel", target: POLICY, type: "relates-to" },
      (v) => {
        ok(v);
        v.check("the target is the concept's urn", (v.note("_fixtures/rel/semantic/Eval-Probe-Rel.md") ?? "").includes(`target: ${POLICY_ID}`), (v.note("_fixtures/rel/semantic/Eval-Probe-Rel.md") ?? "").match(/target: .*/g));
      },
      { writes: true, server: "memory" },
    ),
    mode: "bundles",
  },
];

for (const c of cases) if (NEEDS_STORE.includes(c.id)) c.needs = "store";
