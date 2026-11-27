// The MCP server (Phase 0 of docs/PLAN-mcp.md): the real endpoint on a
// loopback port, over a MifManager on the in-memory vault and a fake mif-cli,
// driven by the SDK's own client and by raw HTTP for what a client would
// never send.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MifCli } from "../src/cliBridge";
import { MifManager } from "../src/manager";
import { MAX_BODY, newToken, refusal, sameToken, startEndpoint, type McpEndpoint } from "../src/mcp/http";
import { guide, PROMPT_NAMES, RESOURCE_PAGE, RESOURCE_TEMPLATE } from "../src/mcp/extras";
import { WRITE_PROMPT_NAMES, WRITE_TOOL_NAMES } from "../src/mcp/write";
import { TaskStore } from "../src/mcp/tasks";
import { AUDIT_LOG } from "../src/mcpWrites";
import { CHARACTER_LIMIT, countEdges, countsLine, sectionOf, TOOL_NAMES } from "../src/mcp/tools";
import { McpService, mcpServing, SwitchMirror, VaultMcpHost } from "../src/mcpHost";
import { DEFAULT_SETTINGS, type MifSettings } from "../src/settings";
import { OntologyStore } from "../src/ontologyStore";
import { CATALOG_URL } from "../src/ontologyStore";
import { MarkdownView, memoryAdapter, memoryApp, network, notices } from "./support/obsidian-stub";

const vaultNote = (p: string) => readFileSync(join(__dirname, "../test-vault", p), "utf8");
const POLICY = "urn:mif:7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e";
const INCIDENT = "urn:mif:a1d2c3b4-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const RUNBOOK = "urn:mif:c4b5a6d7-8f90-4123-a456-7b8c9d0e1f23";
const OLD = "urn:mif:0d0d0d0d-1111-4222-8333-444444444444";
const POLICY_PATH = "semantic/rate-limit-policy.md";
const INCIDENT_PATH = "episodic/incident-2026-01-rate-spike.md";
const RUNBOOK_PATH = "procedural/rotate-api-keys.md";

// A concept that stopped being valid on 2026-02-01 and points at the policy.
const OLD_LIMIT = `---
id: 0d0d0d0d-1111-4222-8333-444444444444
type: semantic
created: 2025-06-01T00:00:00Z
namespace: _semantic/policies
title: Old Rate Limit
temporal:
  "@type": TemporalMetadata
  validFrom: 2025-06-01T00:00:00Z
  validUntil: 2026-02-01T00:00:00Z
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: uncertain
citations:
  - "@type": Citation
    citationType: specification
    citationRole: source
    title: Gateway manual
    url: https://example.test/manual
entities:
  - entity:
      "@id": urn:mif:entity:policy:rate-limit
    name: Rate limit
    role: subject
ontology:
  "@type": OntologyReference
  id: gateway-ops
  version: 1.0.0
  uri: https://example.test/ontologies/gateway-ops
entity:
  name: Old Rate Limit
  entity_type: how-to-guide
relationships:
  - type: relates-to
    target: /semantic/rate-limit-policy.md
---
# Old Rate Limit

The limit was 50 requests per minute.

## Relationships

- relates-to [API Rate Limit Policy](/semantic/rate-limit-policy.md)
`;

// A bundle-local ontology: "how-to-guide" is declared a subtype of "guide".
const ONTOLOGY = `ontology:
  id: gateway-ops
  version: 1.0.0
  description: Gateway operations
namespaces:
  semantic:
    children:
      policies:
        description: Policies
entity_types:
  - name: guide
    base: procedural
    description: Any guide
  - name: how-to-guide
    base: procedural
    subtype_of: [guide]
`;

// Tool names of the org's other MCP servers (mif-rs: mif-mcp, mif-rh-mcp), as of 2026-11-26.
const OTHER_SERVERS = [
  "corpus_stats", "emit_jsonld_document", "emit_markdown_document", "find_similar_documents", "get_passage", "ingest_mif_document",
  "remove_document", "resolve_ontology_reference", "roundtrip_mif_document", "search_documents", "validate_mif_document",
  "find_similar", "search", "suggest_type",
];

const searchOutput = JSON.stringify({
  matches: [
    { id: POLICY, score: 0.03, cosine: 0.71, bm25: -12, path: "semantic/rate-limit-policy.md", title: "API Rate Limit Policy", entity_type: null, concept_type: "semantic", heading: "Rationale", text: "API Rate Limit Policy\nRationale\nLimits protect the gateway.", span: null },
    { id: OLD, score: 0.02, cosine: 0.55, bm25: null, path: "semantic/old-limit.md", title: "Old Rate Limit", entity_type: null, concept_type: "semantic", heading: null, text: "Old Rate Limit\nThe limit was 50 requests per minute.", span: null },
    { id: "urn:mif:ffffffff-0000-4000-8000-000000000000", score: 0.01, cosine: 0.2, bm25: null, path: "gone.md", title: "Gone", entity_type: null, concept_type: "semantic", heading: null, text: "Gone", span: null },
  ],
});

async function vault(opts: { store?: boolean; notes?: Record<string, string>; roots?: string[]; dot?: Record<string, string>; search?: (args: string[]) => string; settings?: Partial<MifSettings> } = {}) {
  const v = memoryApp(
    opts.notes ?? {
      "semantic/rate-limit-policy.md": vaultNote("semantic/rate-limit-policy.md"),
      "episodic/incident-2026-01-rate-spike.md": vaultNote("episodic/incident-2026-01-rate-spike.md"),
      "procedural/rotate-api-keys.md": vaultNote("procedural/rotate-api-keys.md"),
      "semantic/old-limit.md": OLD_LIMIT,
      "plain.md": "Just a note.\n",
    },
  );
  const hasStore = opts.store ?? true;
  const dotFiles = new Map<string, string>(Object.entries(opts.dot ?? { ".mif/ontologies/gateway-ops.ontology.yaml": ONTOLOGY, ...(hasStore ? { ".mif/vectors.db": "db" } : {}) }));
  (v.app.vault as { adapter: unknown }).adapter = memoryAdapter(dotFiles);
  const settings: MifSettings = { ...DEFAULT_SETTINGS, downloadOntologies: false, mifCliPath: "/bin/mif-cli", mcpPurpose: "Gateway operations memory", ...(opts.roots ? { bundleRoots: opts.roots } : {}), ...opts.settings };
  const ontologyStore = new OntologyStore(v.app as never, ".obsidian/plugins/mif");
  await ontologyStore.loadCache();
  const manager = new MifManager(v.app as never, () => settings, ontologyStore);
  await manager.loadBundles();
  await manager.scanAll();
  manager.rebuildIndexes();
  const calls: string[][] = [];
  const exec = (_file: string, args: string[], _o: unknown, cb: (e: (Error & { code?: number }) | null, out: string, err: string) => void) => {
    const a = args.slice(2);
    if (a[0] === "--version") return cb(null, "mif-cli 0.13.0\n", "");
    calls.push(a);
    const out: Record<string, string> = {
      search: opts.search ? opts.search(a) : searchOutput,
      // Every concept's neighbours, nearest first; a concept's own row is ignored by the callers.
      "find-similar": `0.8000  ${RUNBOOK}\n0.4000  ${INCIDENT}\n`,
      "corpus-stats": "count=3 dim=384 db=/v/.mif/vectors.db passages=9 documents_without_passages=0 documents_without_text=0\n",
      prune: "would prune 0 documents, 4 found under /v (db=/v/.mif/vectors.db)\n",
    };
    cb(null, out[a[0]!] ?? "", "");
  };
  const cli = new MifCli(v.app as never, manager, () => settings, exec as never, () => ({ path: "", home: "/h", windows: false, isExecutable: () => false }));
  return { host: new VaultMcpHost(v.app as never, manager, cli, () => settings), settings, calls, dotFiles, manager, mem: v };
}

const TOKEN = "t".repeat(64);
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "0" },
};

/** A request exactly as written, including headers a well-behaved client never sends. */
function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/mcp", headers: opts.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const modern = (method: string, params: Record<string, unknown>, name?: string, headerName = name) => ({
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(headerName ? { "Mcp-Name": headerName } : {}),
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
});

type Called = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
const textOf = (r: Called) => r.content.map((c) => c.text ?? "").join("\n");

describe("tool names", () => {
  it("are prefixed and collide with no other MIF server's tools", () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^mif_vault_[a-z_]+$/);
      expect(OTHER_SERVERS).not.toContain(name);
      expect(OTHER_SERVERS).not.toContain(name.replace(/^mif_vault_/, ""));
    }
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    for (const name of PROMPT_NAMES) {
      expect(name).toMatch(/^mif_vault_[a-z_]+$/);
      expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });
});

describe("request guards", () => {
  const ok = { url: "/mcp", headers: { host: "127.0.0.1:27182", authorization: `Bearer ${TOKEN}` } };
  it("lets a local, authenticated request through", () => {
    expect(refusal(ok, TOKEN)).toBeUndefined();
    expect(refusal({ ...ok, headers: { ...ok.headers, host: "localhost:27182", origin: "http://localhost:3000" } }, TOKEN)).toBeUndefined();
  });
  it("refuses a foreign Host or Origin with 403, before looking at the token", () => {
    expect(refusal({ ...ok, headers: { ...ok.headers, host: "evil.example:27182" } }, TOKEN)?.status).toBe(403);
    expect(refusal({ ...ok, headers: { ...ok.headers, origin: "https://evil.example" } }, TOKEN)?.status).toBe(403);
    expect(refusal({ ...ok, headers: { ...ok.headers, origin: "null" } }, TOKEN)?.status).toBe(403);
    expect(refusal({ url: "/mcp", headers: {} }, TOKEN)?.status).toBe(403);
  });
  it("refuses a missing or wrong token with 401, and any other path with 404", () => {
    expect(refusal({ ...ok, headers: { host: "127.0.0.1" } }, TOKEN)?.status).toBe(401);
    expect(refusal({ ...ok, headers: { ...ok.headers, authorization: "Bearer nope" } }, TOKEN)?.status).toBe(401);
    expect(refusal({ ...ok, url: "/other" }, TOKEN)?.status).toBe(404);
    expect(refusal(ok, "")?.status).toBe(401);
  });
  it("compares tokens exactly and generates 256-bit ones", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abd", "abc")).toBe(false);
    expect(sameToken("abcabc", "abc")).toBe(false);
    expect(sameToken("", "")).toBe(false);
    expect(newToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(newToken());
  });
});

describe("relationship counts", () => {
  it("count by direction and type, most frequent first", () => {
    const c = countEdges([
      { type: "relates-to", direction: "outgoing", target: "a" },
      { type: "relates-to", direction: "outgoing", target: "b" },
      { type: "constrains", direction: "outgoing", target: "c" },
      { type: "briefed-in", direction: "incoming", target: "d" },
    ]);
    expect(c).toEqual({ outgoing: { "relates-to": 2, constrains: 1 }, incoming: { "briefed-in": 1 } });
    expect(countsLine(c)).toBe("Relationships it declares (outgoing): relates-to 2, constrains 1. Relationships other concepts declare to it (incoming): briefed-in 1.");
  });
});

describe("sectionOf", () => {
  const body = "# T\n\nintro\n\n## A\n\none\n\n### A1\n\ndeep\n\n## B\n\ntwo\n";
  it("returns a heading's text down to the next heading of its level", () => {
    expect(sectionOf(body, "A")).toBe("## A\n\none\n\n### A1\n\ndeep");
    expect(sectionOf(body, "## b")).toBe("## B\n\ntwo");
    expect(sectionOf(body, "missing")).toBeUndefined();
  });
});

describe("the endpoint", () => {
  let endpoint: McpEndpoint;
  let client: Client;
  let calls: string[][];

  beforeAll(async () => {
    const v = await vault();
    calls = v.calls;
    endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1", structured: true });
    // The SDK client speaks the 2025 handshake unless told otherwise; pin the current revision.
    client = new Client({ name: "vitest", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  });
  afterAll(async () => {
    await client.close();
    await endpoint.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Called;

  it("answers server/discover with identity, the 2026-07-28 revision and instructions", async () => {
    const d = await client.discover();
    expect(d.supportedVersions).toContain("2026-07-28");
    expect(d.capabilities.tools).toBeDefined();
    expect(d.instructions).toContain("Purpose: Gateway operations memory. Concepts are");
    expect(d.instructions).toContain("evidence, not fact");
    expect(JSON.stringify(d._meta)).toContain("mif-vault");
  });

  it("lists its tools in a fixed order, each read-only with schemas and a self-sufficient description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.outputSchema).toBeDefined();
      expect(t.inputSchema.properties).toHaveProperty("response_format");
      // Guidance must not depend on the server's instructions (plan M15).
      expect(t.description).toMatch(/evidence|freshness/);
      expect(t.description!.length).toBeGreaterThan(120);
    }
  });

  it("reads a concept by canonical id and by path, with its weighing in words", async () => {
    const byId = await call("mif_vault_get_concept", { concept: POLICY });
    expect(byId.isError).toBeFalsy();
    expect(byId.structuredContent).toMatchObject({ concept: { id: POLICY, path: "semantic/rate-limit-policy.md", title: "API Rate Limit Policy", type: "semantic" }, truncated: false });
    expect(textOf(byId)).toContain("freshness: timeless");
    expect(textOf(byId)).toContain("trust: not recorded");
    const byPath = await call("mif_vault_get_concept", { concept: "/semantic/rate-limit-policy.md", response_format: "json" });
    expect(JSON.parse(textOf(byPath))).toEqual(byPath.structuredContent);
    expect(byPath.structuredContent!.concept).toEqual(byId.structuredContent!.concept);
  });

  it("returns one section, and names the headings when the section is missing", async () => {
    const r = await call("mif_vault_get_concept", { concept: POLICY, section: "Rationale" });
    expect(r.structuredContent!.text).toMatch(/^## Rationale/);
    expect(String(r.structuredContent!.text)).not.toContain("## Relationships");
    const bad = await call("mif_vault_get_concept", { concept: POLICY, section: "Nope" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('"Rationale"');
  });

  it("warns in words when a concept has expired, and judges freshness at as_of", async () => {
    const now = await call("mif_vault_get_concept", { concept: OLD });
    expect(now.structuredContent!.weighing).toMatchObject({ freshness: "expired", trust: "uncertain", source_type: "agent_inferred" });
    expect(textOf(now)).toContain("Caution: this concept has expired");
    const then = await call("mif_vault_get_concept", { concept: OLD, as_of: "2026-01-20" });
    expect((then.structuredContent!.weighing as { freshness: string }).freshness).not.toBe("expired");
    expect(textOf(then)).not.toContain("Caution");
  });

  it("says what to do when a concept is not found or a date is not a date", async () => {
    const missing = await call("mif_vault_get_concept", { concept: "urn:mif:00000000-0000-4000-8000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("mif_vault_search_concepts");
    expect((await call("mif_vault_get_concept", { concept: "plain.md" })).isError).toBe(true);
    const date = await call("mif_vault_get_concept", { concept: POLICY, as_of: "last tuesday" });
    expect(date.isError).toBe(true);
    expect(textOf(date)).toContain("ISO 8601");
  });

  it("lists typed relationships both ways and leaves expired ends out unless asked", async () => {
    const r = await call("mif_vault_list_relationships", { concept: POLICY });
    const rels = r.structuredContent!.relationships as Array<{ type: string; direction: string; path?: string; title?: string; strength?: number; hop: number }>;
    expect(rels.map((e) => [e.direction, e.type, e.path])).toEqual([
      ["outgoing", "derived-from", INCIDENT_PATH],
      ["outgoing", "relates-to", RUNBOOK_PATH],
      ["incoming", "relates-to", RUNBOOK_PATH],
    ]);
    expect(rels[0]!.title).toBe("Rate Spike Incident 2026-01");
    expect(rels[0]!.strength).toBe(0.9);
    expect(r.structuredContent).toMatchObject({ total_count: 3, count: 3, has_more: false, excluded_expired: 1, types: ["derived-from", "relates-to"] });
    expect(textOf(r)).toContain("include_expired: true");
    const all = await call("mif_vault_list_relationships", { concept: POLICY, include_expired: true });
    expect((all.structuredContent!.relationships as Array<{ path?: string }>).map((e) => e.path)).toContain("semantic/old-limit.md");
    const past = await call("mif_vault_list_relationships", { concept: POLICY, as_of: "2026-01-20" });
    expect(past.structuredContent!.excluded_expired).toBe(0);
  });

  it("follows relationships to a depth, filters by type and direction, and pages", async () => {
    const two = await call("mif_vault_list_relationships", { concept: INCIDENT, depth: 2 });
    const rels = two.structuredContent!.relationships as Array<{ hop: number; type: string; from: string; path?: string }>;
    expect(rels.filter((e) => e.hop === 1).map((e) => [e.type, e.path])).toEqual([["derived-from", POLICY_PATH]]);
    expect(rels.filter((e) => e.hop === 2).every((e) => e.from === POLICY_PATH)).toBe(true);
    expect(rels.filter((e) => e.hop === 2).map((e) => e.path)).toContain(RUNBOOK_PATH);
    const typed = await call("mif_vault_list_relationships", { concept: POLICY, types: ["derived-from"], direction: "outgoing" });
    expect(typed.structuredContent).toMatchObject({ total_count: 1 });
    const paged = await call("mif_vault_list_relationships", { concept: POLICY, limit: 2 });
    expect(paged.structuredContent).toMatchObject({ count: 2, total_count: 3, has_more: true, next_offset: 2 });
    const rest = await call("mif_vault_list_relationships", { concept: POLICY, limit: 2, offset: 2 });
    expect(rest.structuredContent).toMatchObject({ count: 1, has_more: false });
    const none = await call("mif_vault_list_relationships", { concept: INCIDENT, direction: "outgoing" });
    expect(textOf(none)).toContain("no typed relationships");
  });

  it("finds a concept by its title, or by a word or code in it, and lists the candidates when several match", async () => {
    const exact = await call("mif_vault_get_concept", { concept: "rotate api keys", include_body: false });
    expect(exact.structuredContent).toMatchObject({ concept: { id: RUNBOOK } });
    expect(exact.structuredContent!.text).toBeUndefined();
    const word = await call("mif_vault_list_relationships", { concept: "Incident", counts_only: true });
    expect(word.structuredContent).toMatchObject({ concepts: [{ concept: { id: INCIDENT } }], relationships: [] });
    const many = await call("mif_vault_get_concept", { concept: "Rate" });
    expect(many.isError).toBe(true);
    expect(textOf(many)).toContain("semantic/rate-limit-policy.md — API Rate Limit Policy");
    expect(textOf(many)).toContain("episodic/incident-2026-01-rate-spike.md");
    expect((await call("mif_vault_get_concept", { concept: "no such title" })).isError).toBe(true);
  });

  it("counts a concept's relationships by type and direction, including those other concepts declare to it", async () => {
    const got = await call("mif_vault_get_concept", { concept: INCIDENT, include_body: false });
    expect(got.structuredContent!.relationship_counts).toEqual({ outgoing: {}, incoming: { "derived-from": 1 } });
    expect(textOf(got)).toContain("Relationships it declares (outgoing): none. Relationships other concepts declare to it (incoming): derived-from 1.");
    const policy = await call("mif_vault_list_relationships", { concept: POLICY, counts_only: true });
    // Nothing is listed, but the totals and the types still say what the counts add up to.
    expect(policy.structuredContent).toMatchObject({ total_count: 4, count: 0, types: ["derived-from", "relates-to"], relationships: [] });
    expect((await call("mif_vault_list_relationships", { concept: POLICY, counts_only: true, direction: "incoming", types: ["relates-to"] })).structuredContent).toMatchObject({ total_count: 2, types: ["relates-to"] });
    // Counts are not filtered by freshness: the expired note's relationship is counted, though the listing leaves it out.
    expect(policy.structuredContent!.concepts).toEqual([
      { concept: { id: POLICY, path: POLICY_PATH, bundle: "", title: "API Rate Limit Policy", type: "semantic" }, relationship_counts: { outgoing: { "derived-from": 1, "relates-to": 1 }, incoming: { "relates-to": 2 } } },
    ]);
    expect(policy.structuredContent).toMatchObject({ count: 0, relationships: [] });
    // A filter that matches nothing still says what the concept has.
    const none = await call("mif_vault_list_relationships", { concept: INCIDENT, types: ["relates-to"] });
    expect(textOf(none)).toContain("its counts show what it does have");
    expect(textOf(none)).toContain("incoming): derived-from 1");
  });

  it("lists compactly by default, and states every related concept's weighing in full on request", async () => {
    // Compact is the default by the owner's decision (plan M29); it is the same as asking for it.
    const byDefault = await call("mif_vault_list_relationships", { concept: POLICY, include_expired: true });
    const compact = await call("mif_vault_list_relationships", { concept: POLICY, include_expired: true, detail: "compact" });
    expect(textOf(byDefault)).toBe(textOf(compact));
    expect(byDefault.structuredContent).toEqual(compact.structuredContent);
    const text = textOf(compact);
    // A title only one concept has is a complete handle, so the path is left out.
    expect(text).toContain("declares derived-from → (1)\n  - Rate Spike Incident 2026-01\n");
    expect(text).not.toContain("[episodic/incident-2026-01-rate-spike.md]");
    expect(text).toContain("relates-to declared to it by ← (2)");
    expect(text).toContain("  - Old Rate Limit — EXPIRED");
    expect(text).not.toContain("urn:mif:a1d2c3b4");
    expect(text).not.toContain("trust:");
    const rows = compact.structuredContent!.relationships as Array<{ id?: string; weighing?: { freshness: string } }>;
    expect(rows.every((r) => r.id === undefined)).toBe(true);
    expect(rows.filter((r) => r.weighing).map((r) => r.weighing!.freshness)).toEqual(["expired"]);
    // The full form carries the weighing of every concept: freshness, trust, level and open diagnostics, with its id.
    const full = await call("mif_vault_list_relationships", { concept: POLICY, detail: "full" });
    const rowsFull = full.structuredContent!.relationships as Array<{ id?: string; weighing?: { freshness: string; level: number; errors: number; warnings: number } }>;
    expect(rowsFull).toHaveLength(3);
    expect(rowsFull.every((r) => r.id && r.weighing && typeof r.weighing.level === "number" && typeof r.weighing.errors === "number")).toBe(true);
    expect(textOf(full)).toContain(`  - Rate Spike Incident 2026-01 (${INCIDENT}, episodic/incident-2026-01-rate-spike.md)\n      freshness: timeless · trust: not recorded · MIF level`);
    // Reading one concept always states its weighing in full, whatever the list default.
    expect(textOf(await call("mif_vault_get_concept", { concept: POLICY, include_body: false }))).toContain("freshness: timeless · trust: not recorded · MIF level");
    expect((full.structuredContent!.relationships as Array<{ weighing?: unknown; id?: string }>).every((r) => r.weighing && r.id)).toBe(true);
    expect(text.length).toBeLessThan(textOf(full).length);
  });

  it("answers for several concepts in one call, and says what they share or do not", async () => {
    const each = await call("mif_vault_list_relationships", { concept: [INCIDENT, "Rotate API Keys"], detail: "compact" });
    expect((each.structuredContent!.concepts as Array<{ concept: { id: string } }>).map((c) => c.concept.id)).toEqual([INCIDENT, RUNBOOK]);
    expect(each.structuredContent).toMatchObject({ combine: "each", total_count: 3 });
    expect(textOf(each)).toContain("Rate Spike Incident 2026-01 [episodic/incident-2026-01-rate-spike.md]: 1 relationship(s).");
    expect(textOf(each)).toContain("Rotate API Keys [procedural/rotate-api-keys.md]: 2 relationship(s).");
    const shared = await call("mif_vault_list_relationships", { concept: [INCIDENT, RUNBOOK], combine: "intersect", detail: "compact" });
    expect((shared.structuredContent!.relationships as Array<{ path?: string }>).map((r) => r.path)).toEqual([POLICY_PATH]);
    expect(textOf(shared)).toContain("1 concept(s) have a relationship with all of: Rate Spike Incident 2026-01, Rotate API Keys.\n  - API Rate Limit Policy");
    const only = await call("mif_vault_list_relationships", { concept: [POLICY, INCIDENT], combine: "subtract", direction: "outgoing" });
    expect((only.structuredContent!.relationships as Array<{ path?: string }>).map((r) => r.path)).toEqual([INCIDENT_PATH, RUNBOOK_PATH]);
    const none = await call("mif_vault_list_relationships", { concept: [INCIDENT, RUNBOOK], combine: "subtract" });
    expect(none.structuredContent).toMatchObject({ total_count: 0, relationships: [] });
    const any = await call("mif_vault_list_relationships", { concept: [INCIDENT, POLICY], combine: "union", types: ["relates-to"] });
    expect((any.structuredContent!.relationships as Array<{ path?: string }>).map((r) => r.path)).toEqual([RUNBOOK_PATH]);
    expect((await call("mif_vault_list_relationships", { concept: [POLICY, POLICY], combine: "intersect" })).isError).toBe(true);
    expect((await call("mif_vault_list_relationships", { concept: [POLICY, "no such concept"] })).isError).toBe(true);
  });

  it("follows a chain of relationship types, one per hop", async () => {
    const r = await call("mif_vault_list_relationships", { concept: INCIDENT, path: [{ type: "derived-from", direction: "incoming" }, { type: "relates-to" }], detail: "compact" });
    const rows = r.structuredContent!.relationships as Array<{ hop: number; type: string; direction: string; from: string; path?: string }>;
    expect(rows).toEqual([
      { hop: 1, from: INCIDENT_PATH, type: "derived-from", direction: "incoming", path: POLICY_PATH, title: "API Rate Limit Policy", strength: 0.9 },
      { hop: 2, from: POLICY_PATH, type: "relates-to", direction: "outgoing", path: RUNBOOK_PATH, title: "Rotate API Keys" },
    ]);
    expect(textOf(r)).toContain("hop 2, API Rate Limit Policy: declares relates-to → (1)\n  - Rotate API Keys");
    const dead = await call("mif_vault_list_relationships", { concept: INCIDENT, path: [{ type: "relates-to" }] });
    expect(dead.structuredContent).toMatchObject({ total_count: 0 });
    expect((await call("mif_vault_list_relationships", { concept: [INCIDENT, POLICY], combine: "intersect", path: [{ type: "relates-to" }] })).isError).toBe(true);
  });

  it("adds each related concept's own counts on request, to compare them in one call", async () => {
    const r = await call("mif_vault_list_relationships", { concept: POLICY, direction: "outgoing", neighbor_counts: true, detail: "compact" });
    const rows = r.structuredContent!.relationships as Array<{ path?: string; counts?: unknown }>;
    expect(rows.map((x) => [x.path, x.counts])).toEqual([
      [INCIDENT_PATH, { outgoing: {}, incoming: { "derived-from": 1 } }],
      [RUNBOOK_PATH, { outgoing: { "relates-to": 1 }, incoming: { "relates-to": 1 } }],
    ]);
    expect(textOf(r)).toContain("  - Rotate API Keys — declares: relates-to 1; declared to it: relates-to 1");
    const plain = await call("mif_vault_list_relationships", { concept: POLICY, direction: "outgoing" });
    expect((plain.structuredContent!.relationships as Array<{ counts?: unknown }>).every((x) => x.counts === undefined)).toBe(true);
  });

  it("lists concepts by their facts, and by how many relationships of a kind they have", async () => {
    const all = await call("mif_vault_list_concepts", {});
    expect(all.structuredContent).toMatchObject({ total_count: 3, excluded_expired: 1 });
    expect((all.structuredContent!.concepts as Array<{ title: string }>).map((c) => c.title)).toEqual(["API Rate Limit Policy", "Rate Spike Incident 2026-01", "Rotate API Keys"]);
    expect(textOf(all)).toContain("include_expired: true");
    const typed = await call("mif_vault_list_concepts", { type: "procedural" });
    expect((typed.structuredContent!.concepts as Array<{ path: string }>).map((c) => c.path)).toEqual([RUNBOOK_PATH]);
    const titled = await call("mif_vault_list_concepts", { title_contains: "RATE", namespace: "_semantic", include_expired: true });
    expect((titled.structuredContent!.concepts as Array<{ title: string }>).map((c) => c.title)).toEqual(["API Rate Limit Policy", "Old Rate Limit"]);
    const stale = await call("mif_vault_list_concepts", { freshness: ["expired"], detail: "full" });
    expect(stale.structuredContent!.concepts).toMatchObject([{ path: "semantic/old-limit.md", id: OLD, weighing: { freshness: "expired", trust: "uncertain" } }]);
    // The vault-wide question no relationship listing can answer: who has two or more of a kind.
    const many = await call("mif_vault_list_concepts", { relationship: { type: "relates-to", direction: "incoming", min: 2 }, detail: "compact" });
    expect(many.structuredContent!.concepts).toMatchObject([{ path: POLICY_PATH, relationships: 2 }]);
    expect(textOf(many)).toContain("  - API Rate Limit Policy — 2");
    const none = await call("mif_vault_list_concepts", { relationship: { direction: "outgoing", min: 0, max: 0 } });
    expect((none.structuredContent!.concepts as Array<{ path: string }>).map((c) => c.path)).toEqual([INCIDENT_PATH]);
    const ranked = await call("mif_vault_list_concepts", { relationship: { min: 0 }, sort: "relationships", limit: 1 });
    expect(ranked.structuredContent).toMatchObject({ concepts: [{ path: POLICY_PATH, relationships: 4 }], has_more: true, next_offset: 1 });
    const grouped = await call("mif_vault_list_concepts", { group_by: "type", include_expired: true });
    expect(grouped.structuredContent).toMatchObject({ total_count: 4, groups: { semantic: 2, episodic: 1, procedural: 1 }, concepts: [] });
    const unknown = await call("mif_vault_list_concepts", { entity_type: "nothing" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('No entity type "nothing" in this vault.');
    expect(textOf(unknown)).toContain("how-to-guide");
  });

  it("lists the entities concepts refer to, and who refers to them", async () => {
    const r = await call("mif_vault_list_entities", { include_references: true });
    expect(r.structuredContent!.entities).toEqual([
      { urn: "urn:mif:entity:policy:rate-limit", name: "Rate limit", type: "policy", bundle: "", recorded: false, reference_count: 1, references: [{ path: "semantic/old-limit.md", title: "Old Rate Limit", role: "subject" }] },
    ]);
    expect(textOf(r)).toContain("no entity record, only referenced");
    expect((await call("mif_vault_list_entities", { referenced_by: POLICY })).structuredContent).toMatchObject({ total_count: 0 });
    expect((await call("mif_vault_list_entities", { referenced_by: OLD, name_contains: "rate", type: "Policy" })).structuredContent).toMatchObject({ total_count: 1 });
    expect((await call("mif_vault_list_entities", { group_by_type: true })).structuredContent).toMatchObject({ groups: { policy: 1 } });
  });

  it("traces a concept to its sources on request", async () => {
    const r = await call("mif_vault_get_concept", { concept: OLD, include_body: false, include: ["citations", "provenance", "entities"] });
    expect(r.structuredContent).toMatchObject({
      citations: [{ title: "Gateway manual", url: "https://example.test/manual" }],
      provenance: { sourceType: "agent_inferred", trustLevel: "uncertain" },
      entities: [{ urn: "urn:mif:entity:policy:rate-limit", name: "Rate limit", role: "subject" }],
    });
    expect(textOf(r)).toContain("Citations (1):\n  - Gateway manual · specification · source · https://example.test/manual");
    expect(textOf(r)).toContain("Provenance: sourceType agent_inferred; trustLevel uncertain");
    const bare = await call("mif_vault_get_concept", { concept: INCIDENT, include_body: false, include: ["citations"] });
    expect(bare.structuredContent).toMatchObject({ citations: [] });
    expect(bare.structuredContent!.provenance).toBeUndefined();
    expect(textOf(bare)).toContain("Citations: none recorded.");
  });

  it("finds the shortest chain of relationships between two concepts", async () => {
    const r = await call("mif_vault_list_relationships", { concept: INCIDENT, path_to: "Rotate API Keys", detail: "compact" });
    const rows = r.structuredContent!.relationships as Array<{ hop: number; from: string; path?: string; type: string }>;
    expect(rows.map((x) => [x.hop, x.from, x.type, x.path])).toEqual([
      [1, INCIDENT_PATH, "derived-from", POLICY_PATH],
      [2, POLICY_PATH, "relates-to", RUNBOOK_PATH],
    ]);
    expect(textOf(r)).toContain("Rate Spike Incident 2026-01 and Rotate API Keys are 2 relationship(s) apart.");
    const blocked = await call("mif_vault_list_relationships", { concept: INCIDENT, path_to: RUNBOOK, types: ["relates-to"] });
    expect(blocked.structuredContent).toMatchObject({ total_count: 0 });
    expect(textOf(blocked)).toContain("No chain of typed relationships within 6 hops");
    expect((await call("mif_vault_list_relationships", { concept: [INCIDENT, POLICY], path_to: RUNBOOK })).isError).toBe(true);
  });

  it("finds the concepts nearest to one, and applies a cosine floor", async () => {
    const r = await call("mif_vault_search_concepts", { similar_to: "API Rate Limit Policy" });
    expect(calls.at(-1)!.slice(0, 2)).toEqual(["find-similar", POLICY]);
    expect((r.structuredContent!.results as Array<{ id: string; cosine: number }>).map((h) => [h.id, h.cosine])).toEqual([[RUNBOOK, 0.8], [INCIDENT, 0.4]]);
    expect(r.structuredContent!.thresholds).toEqual({ duplicate: 0.55, similar: 0.55, mislink: 0.1 });
    expect(textOf(r)).toContain("Results for concepts similar to API Rate Limit Policy:");
    const close = await call("mif_vault_search_concepts", { similar_to: POLICY, min_cosine: 0.55 });
    expect((close.structuredContent!.results as Array<{ id: string }>).map((h) => h.id)).toEqual([RUNBOOK]);
    expect(textOf(close)).toContain("cosine 0.55 or more as a likely duplicate");
    const far = await call("mif_vault_search_concepts", { query: "rate limits", min_cosine: 0.99 });
    expect(textOf(far)).toContain("at cosine 0.99 or more");
    expect((await call("mif_vault_search_concepts", {})).isError).toBe(true);
    expect((await call("mif_vault_search_concepts", { query: "x", similar_to: POLICY })).isError).toBe(true);
  });

  it("reports on the graph, the vector store and relationship gaps", async () => {
    const graph = await call("mif_vault_get_status", {});
    expect(graph.structuredContent!.graph).toEqual({
      bundles: [""],
      concepts: 4,
      by_type: { semantic: 2, episodic: 1, procedural: 1 },
      by_entity_type: { "(none)": 3, "how-to-guide": 1 },
      relationships: 4,
      by_relationship_type: { "relates-to": 3, "derived-from": 1 },
      unresolved_targets: 0,
      without_relationships: 0,
      freshness: { timeless: 3, expired: 1 },
      trust: { "(none)": 3, uncertain: 1 },
      entities: 1,
      ontologies: [{ id: "gateway-ops", version: "1.0.0", uri: "urn:mif:ontology:gateway-ops", published_at: "https://example.test/ontologies/gateway-ops", address: "declared" }],
      duplicate_ids: [],
      awaiting_review: 1,
    });
    expect(textOf(graph)).toContain("No id is carried by more than one note.");
    expect(textOf(graph)).toContain("4 concept(s) in 1 bundle(s), 4 typed relationship(s), 1 entity.");
    const store = await call("mif_vault_get_status", { report: "store", limit: 2 });
    expect(store.structuredContent!.stores).toMatchObject([{ bundle: "", stored: 3, current: 0, changed_count: 0, never_count: 4, orphans: 0 }]);
    expect(((store.structuredContent!.stores as Array<{ never: string[] }>)[0]!).never).toHaveLength(2);
    expect(textOf(store)).toContain("4 never ingested");
    expect(textOf(store)).toContain("Never ingested (first 2)");
    const gaps = await call("mif_vault_get_status", { report: "gaps" });
    expect(gaps.structuredContent!.gaps).toMatchObject({ compared: 4, mislink_count: 0, thresholds: { similar: 0.55 } });
    const unlinked = (gaps.structuredContent!.gaps as { unlinked: Array<{ a: string; b: string; cosine: number }> }).unlinked;
    expect(unlinked.map((p) => [p.a, p.b].sort().join(" / "))).toContain("Rate Spike Incident 2026-01 / Rotate API Keys");
    expect(unlinked.map((p) => [p.a, p.b].sort().join(" / "))).not.toContain("API Rate Limit Policy / Rotate API Keys");
    expect(textOf(gaps)).toContain("Similarity is a prompt to look, not proof");
    // Scope: which concepts the report is about. The comparison still covers the bundle.
    const whole = gaps.structuredContent!.gaps as { unlinked_count: number; mislink_count: number };
    const pairsOf = (r: Called) => (r.structuredContent!.gaps as { unlinked: Array<{ a: string; b: string }> }).unlinked.map((p) => [p.a, p.b].sort().join(" / "));
    const either = await call("mif_vault_get_status", { report: "gaps", scope: { folder: "episodic", match: "either" } });
    expect(pairsOf(either)).toEqual(["Rate Spike Incident 2026-01 / Rotate API Keys"]);
    expect(either.structuredContent!.gaps).toMatchObject({ unlinked_count: 1, unscoped_unlinked_count: whole.unlinked_count, unscoped_mislink_count: whole.mislink_count });
    expect(textOf(either)).toContain("Scope: folder episodic; 1 concept(s); a pair is kept when either of its concepts is in scope.");
    // Only one concept is in the folder, so no pair has both ends there.
    const both = await call("mif_vault_get_status", { report: "gaps", scope: { folder: "episodic" } });
    expect(both.structuredContent!.gaps).toMatchObject({ unlinked_count: 0, unlinked: [] });
    const typed = await call("mif_vault_get_status", { report: "gaps", scope: { type: "procedural", namespace: "_procedural", match: "either" } });
    expect(pairsOf(typed).every((p) => p.includes("Rotate API Keys"))).toBe(true);
    expect(pairsOf(typed).length).toBeGreaterThan(0);
    // An entity type the ontology knows but no concept in scope has: nothing, not an error.
    const guides = await call("mif_vault_get_status", { report: "gaps", scope: { entity_type: "guide" } });
    expect(guides.structuredContent!.gaps).toMatchObject({ unlinked_count: 0 });
    expect((await call("mif_vault_get_status", { report: "gaps", scope: { entity_type: "nope" } })).isError).toBe(true);
    expect((await call("mif_vault_get_status", { report: "gaps", scope: {} })).structuredContent!.gaps).toMatchObject({ unlinked_count: whole.unlinked_count });
    expect((await call("mif_vault_get_status", { bundle: "nope" })).isError).toBe(true);
  });

  it("names only tools and prompts that exist, in every description and in the guide", async () => {
    const known = new Set<string>([...TOOL_NAMES, ...PROMPT_NAMES]);
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const guideText = ((await client.getPrompt({ name: "mif_vault_guide" })).messages[0]!.content as { text: string }).text;
    const texts = [...tools.map((t) => `${t.description} ${JSON.stringify(t.inputSchema)}`), ...prompts.map((p) => p.description ?? ""), guideText, (await client.discover()).instructions ?? ""];
    for (const text of texts) for (const m of text.matchAll(/mif_vault_[a-z_]+/g)) expect(known.has(m[0]), m[0]).toBe(true);
    // The guide covers every tool, so a client that shows it leaves none undiscovered.
    for (const name of TOOL_NAMES) expect(guideText).toContain(name);
    expect(guideText).toContain("evidence, not fact");
  });

  it("serves a concept and an entity as resources at their canonical ids", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([RESOURCE_TEMPLATE]);
    const concept = await client.readResource({ uri: POLICY });
    expect(concept.contents).toHaveLength(1);
    expect(concept.contents[0]).toMatchObject({ uri: POLICY, mimeType: "text/markdown" });
    const text = (concept.contents[0] as { text: string }).text;
    expect(text).toMatch(/^# API Rate Limit Policy\n\nurn:mif:7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e · semantic\/rate-limit-policy\.md · semantic/);
    expect(text).toContain("freshness: timeless");
    expect(text).toContain("incoming): relates-to 2");
    expect(text).toContain("## Rationale");
    const entity = await client.readResource({ uri: "urn:mif:entity:policy:rate-limit" });
    expect(JSON.parse((entity.contents[0] as { text: string }).text)).toMatchObject({ urn: "urn:mif:entity:policy:rate-limit", name: "Rate limit", recorded: false, references: [{ path: "semantic/old-limit.md", role: "subject" }] });
    await expect(client.readResource({ uri: "urn:mif:00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/No concept/);
    await expect(client.readResource({ uri: "urn:mif:entity:policy:none" })).rejects.toThrow(/No entity/);
    await expect(client.readResource({ uri: "urn:mif:not-an-id" })).rejects.toThrow(/not a MIF id/);
  });

  it("returns the concepts a result names as resource links at their canonical ids", async () => {
    type Linked = { content: Array<{ type: string; uri?: string; name?: string }> };
    const links = (r: Linked) => r.content.filter((c) => c.type === "resource_link").map((c) => c.uri);
    const got = (await client.callTool({ name: "mif_vault_get_concept", arguments: { concept: POLICY, include_body: false } })) as Linked;
    expect(got.content.filter((c) => c.type === "resource_link")).toEqual([{ type: "resource_link", uri: POLICY, name: "API Rate Limit Policy", mimeType: "text/markdown" }]);
    // The concept asked about, then each related concept once, whichever form the text takes.
    for (const detail of ["full", "compact"]) {
      const listed = (await client.callTool({ name: "mif_vault_list_relationships", arguments: { concept: POLICY, detail } })) as Linked;
      expect(links(listed)).toEqual([POLICY, INCIDENT, RUNBOOK]);
    }
    const found = (await client.callTool({ name: "mif_vault_search_concepts", arguments: { query: "rate limits" } })) as Linked;
    expect(links(found)).toEqual([POLICY]);
    const all = (await client.callTool({ name: "mif_vault_list_concepts", arguments: { limit: 2 } })) as Linked;
    expect(links(all)).toEqual([POLICY, INCIDENT]);
    const entities = (await client.callTool({ name: "mif_vault_list_entities", arguments: { include_references: true } })) as Linked;
    expect(links(entities)).toEqual(["urn:mif:entity:policy:rate-limit", OLD]);
    // Every link can be read back.
    for (const uri of links(entities)) expect((await client.readResource({ uri: uri! })).contents).toHaveLength(1);
  });

  it("offers a usage guide and a recall prompt, and completes the recall prompt's filters", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
    expect(((await client.getPrompt({ name: "mif_vault_guide" })).messages[0]!.content as { text: string }).text).toContain('the Obsidian vault "test-vault"');
    const recall = await client.getPrompt({ name: "mif_vault_recall", arguments: { topic: "rate limits", namespace: "_semantic/policies" } });
    const text = (recall.messages[0]!.content as { text: string }).text;
    expect(text).toContain("holds about: rate limits");
    expect(text).toContain('Keep to namespace "_semantic/policies".');
    expect(text).toContain("incoming as well as outgoing");
    const done = await client.complete({ ref: { type: "ref/prompt", name: "mif_vault_recall" }, argument: { name: "namespace", value: "_sem" } });
    expect(done.completion.values).toEqual(["_semantic/policies"]);
    const all = await client.complete({ ref: { type: "ref/prompt", name: "mif_vault_recall" }, argument: { name: "namespace", value: "" } });
    expect(all.completion.values).toEqual(["_semantic/policies", "_episodic/incidents", "_procedural/runbooks"]);
  });

  it("puts the vault's own values into the tool schemas, and names them when an argument is wrong", async () => {
    // The protocol's completion request reaches prompts and resource templates only, so a tool's
    // arguments carry their suggestions in the schema, drawn from the vault on every request.
    const { tools } = await client.listTools();
    const props = (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { examples?: string[]; items?: { examples?: string[] }; properties?: Record<string, { examples?: string[] }> }>;
    expect(props("mif_vault_list_relationships").types!.items!.examples).toEqual(["relates-to", "derived-from"]);
    expect(props("mif_vault_search_concepts").entity_type!.examples).toEqual(["how-to-guide"]);
    expect(props("mif_vault_search_concepts").folder!.examples).toEqual(["semantic", "episodic", "procedural"]);
    expect(props("mif_vault_search_concepts").bundle!.examples).toEqual([""]);
    const listing = props("mif_vault_list_concepts");
    expect(listing.type!.examples).toEqual(["semantic", "episodic", "procedural"]);
    expect(listing.namespace!.examples).toEqual(["_semantic/policies", "_episodic/incidents", "_procedural/runbooks"]);
    expect(listing.trust!.items!.examples).toEqual(["uncertain", "(none)"]);
    expect(listing.relationship!.properties!.type!.examples).toEqual(["relates-to", "derived-from"]);
    expect(props("mif_vault_list_entities").type!.examples).toEqual(["policy"]);
    const wrong = await call("mif_vault_list_relationships", { concept: POLICY, types: ["relates"] });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toBe('No relationship type "relates" in this vault. Did you mean: relates-to? In use: relates-to, derived-from.');
    expect((await call("mif_vault_list_relationships", { concept: POLICY, path: [{ type: "nope" }] })).isError).toBe(true);
    expect((await call("mif_vault_list_concepts", { type: "semantics" })).isError).toBe(true);
    expect((await call("mif_vault_list_concepts", { relationship: { type: "nope" } })).isError).toBe(true);
    expect((await call("mif_vault_list_entities", { type: "nope" })).isError).toBe(true);
    expect((await call("mif_vault_search_concepts", { query: "x", entity_type: "nope" })).isError).toBe(true);
  });

  it("matches an entity type's subtypes as the loaded ontology declares them", async () => {
    // No concept is a "guide"; the ontology says "how-to-guide" is one.
    const broad = await call("mif_vault_list_concepts", { entity_type: "guide", include_expired: true });
    expect((broad.structuredContent!.concepts as Array<{ path: string; entity_type: string }>).map((c) => [c.path, c.entity_type])).toEqual([["semantic/old-limit.md", "how-to-guide"]]);
    const narrow = await call("mif_vault_list_concepts", { entity_type: "guide", include_subtypes: false, include_expired: true });
    expect(narrow.structuredContent).toMatchObject({ total_count: 0 });
    const exact = await call("mif_vault_list_concepts", { entity_type: "How-To-Guide", include_expired: true });
    expect(exact.structuredContent).toMatchObject({ total_count: 1 });
  });

  it("lists every resource page by page, serves an ontology at its declared uri, and completes resource ids", async () => {
    const first = await client.listResources();
    expect(first.resources.map((r) => r.uri)).toEqual([INCIDENT, RUNBOOK, OLD, POLICY, "urn:mif:entity:policy:rate-limit", "urn:mif:ontology:gateway-ops"]);
    expect(first.resources[0]).toMatchObject({ name: "Rate Spike Incident 2026-01", mimeType: "text/markdown", description: "episodic · episodic/incident-2026-01-rate-spike.md" });
    expect(first.nextCursor).toBeUndefined();
    await expect(client.listResources({ cursor: "bogus" })).rejects.toThrow(/Unknown cursor/);
    const ontology = JSON.parse(((await client.readResource({ uri: "urn:mif:ontology:gateway-ops" })).contents[0] as { text: string }).text);
    expect(ontology).toMatchObject({ id: "gateway-ops", version: "1.0.0", uri: "urn:mif:ontology:gateway-ops", published_at: "https://example.test/ontologies/gateway-ops", address: "declared", extends: [], namespaces: ["semantic", "semantic/policies"], bundles: [""] });
    expect(ontology.entity_types).toEqual([
      { name: "guide", base: "procedural", subtype_of: [], description: "Any guide" },
      { name: "how-to-guide", base: "procedural", subtype_of: ["guide"] },
    ]);
    const byUuid = await client.complete({ ref: { type: "ref/resource", uri: RESOURCE_TEMPLATE }, argument: { name: "id", value: "7b3c" } });
    expect(byUuid.completion.values).toEqual([POLICY.replace("urn:mif:", "")]);
    const byTitle = await client.complete({ ref: { type: "ref/resource", uri: RESOURCE_TEMPLATE }, argument: { name: "id", value: "rotate" } });
    expect(byTitle.completion.values).toEqual([RUNBOOK.replace("urn:mif:", "")]);
    const entity = await client.complete({ ref: { type: "ref/resource", uri: RESOURCE_TEMPLATE }, argument: { name: "id", value: "entity:pol" } });
    expect(entity.completion.values).toEqual(["entity:policy:rate-limit"]);
  });

  it("reports progress on the gap report to a caller that asks for it", async () => {
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = (await client.callTool({ name: "mif_vault_get_status", arguments: { report: "gaps" } }, { onprogress: (p) => seen.push(p) })) as Called;
    expect(r.isError).toBeFalsy();
    expect(seen.at(-1)).toMatchObject({ progress: 4, total: 4, message: "Compared 4 of 4 concepts" });
    // Without a progress token nothing is sent, and the result is the same.
    const quiet = await call("mif_vault_get_status", { report: "gaps" });
    expect(quiet.structuredContent!.gaps).toEqual(r.structuredContent!.gaps);
  });

  it("lets clients cache the lists, which change only with the plugin's settings", async () => {
    const list = JSON.parse((await raw(endpoint.port, modern("tools/list", {}))).body) as { result: { ttlMs: number; cacheScope: string } };
    expect(list.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
    const resources = JSON.parse((await raw(endpoint.port, modern("resources/list", {}))).body) as { result: { ttlMs: number } };
    expect(resources.result.ttlMs).toBe(5_000);
  });

  it("cuts long text at max_chars and says so", async () => {
    const r = await call("mif_vault_get_concept", { concept: POLICY, max_chars: 200 });
    expect(r.structuredContent).toMatchObject({ truncated: true });
    expect(String(r.structuredContent!.text).length).toBe(200);
    expect(textOf(r)).toContain("The text was cut at 200 characters");
  });

  it("searches through the plugin's mif-cli bridge and weighs each hit", async () => {
    const r = await call("mif_vault_search_concepts", { query: "rate limits", entity_type: "how-to-guide", folder: "semantic" });
    const search = calls.at(-1)!;
    expect(search.slice(0, 2)).toEqual(["search", "rate limits"]);
    expect(search).toEqual(expect.arrayContaining(["--entity-type", "how-to-guide", "--source-prefix", "semantic/"]));
    expect(search).not.toContain("semantic");
    const results = r.structuredContent!.results as Array<{ id: string; concept?: { path: string }; heading?: string; passage?: string; cosine?: number; weighing?: { freshness: string } }>;
    expect(results.map((h) => h.id)).toEqual([POLICY, "urn:mif:ffffffff-0000-4000-8000-000000000000"]);
    expect(results[0]).toMatchObject({ concept: { path: "semantic/rate-limit-policy.md" }, heading: "Rationale", cosine: 0.71, weighing: { freshness: "timeless" } });
    expect(results[1]!.concept).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ excluded_expired: 1 });
    expect(textOf(r)).toContain('Under "Rationale"');
    expect(textOf(r)).toContain("note is gone");
    const all = await call("mif_vault_search_concepts", { query: "rate limits", include_expired: true, mode: "semantic", limit: 1 });
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["--mode", "semantic"]));
    expect(all.structuredContent).toMatchObject({ count: 1, has_more: true, next_offset: 1 });
  });

  it("treats a limit above the maximum as the maximum, without rejecting the call", async () => {
    const r = await call("mif_vault_list_relationships", { concept: POLICY, limit: 500 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ count: 3, has_more: false });
    expect((await call("mif_vault_search_concepts", { query: "rate limits", limit: 500 })).isError).toBeFalsy();
  });

  it("rejects arguments outside the schema", async () => {
    const r = await client.callTool({ name: "mif_vault_list_relationships", arguments: { concept: POLICY, depth: 9 } }).then((x) => x as Called, (e: Error) => e);
    expect(r instanceof Error || r.isError === true).toBe(true);
  });

  it("refuses requests without the token, from a foreign origin, or for a foreign host", async () => {
    const good = modern("tools/list", {});
    const noToken = await raw(endpoint.port, { ...good, headers: { ...good.headers, Authorization: "" } });
    expect(noToken.status).toBe(401);
    expect(noToken.headers["www-authenticate"]).toContain("Bearer");
    expect((await raw(endpoint.port, { ...good, headers: { ...good.headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw(endpoint.port, { ...good, headers: { ...good.headers, Host: "evil.example" } })).status).toBe(403);
    expect((await raw(endpoint.port, { ...good, path: "/" })).status).toBe(404);
    const ok = await raw(endpoint.port, good);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("mif_vault_get_concept");
  });

  it("follows the 2026-07-28 transport rules: no GET or DELETE, headers must match the body", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await raw(endpoint.port, { method: "GET", headers: { ...auth, Accept: "text/event-stream" } })).status).toBe(405);
    expect((await raw(endpoint.port, { method: "DELETE", headers: auth })).status).toBe(405);
    const mismatch = await raw(endpoint.port, modern("tools/call", { name: "mif_vault_get_concept", arguments: { concept: POLICY } }, "mif_vault_get_concept", "mif_vault_search_concepts"));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toContain("-32020");
    const version = modern("tools/list", {});
    const unsupported = await raw(endpoint.port, { ...version, headers: { ...version.headers, "MCP-Protocol-Version": "2099-01-01" }, body: version.body.replace("2026-07-28", "2099-01-01") });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toContain("2026-07-28");
    const tooBig = await raw(endpoint.port, { ...version, body: "x".repeat(MAX_BODY + 1) });
    expect(tooBig.status).toBe(413);
  });

  it("marks every result complete and list results cacheable, as the revision requires", async () => {
    const list = JSON.parse((await raw(endpoint.port, modern("tools/list", {}))).body) as { result: Record<string, unknown> };
    expect(list.result.resultType).toBe("complete");
    expect(typeof list.result.ttlMs).toBe("number");
    expect(list.result.cacheScope).toBeDefined();
    const got = JSON.parse((await raw(endpoint.port, modern("tools/call", { name: "mif_vault_get_concept", arguments: { concept: POLICY } }, "mif_vault_get_concept"))).body) as { result: Record<string, unknown> };
    expect(got.result.resultType).toBe("complete");
    expect(JSON.stringify(got.result).length).toBeLessThan(CHARACTER_LIMIT * 2);
  });

  it("serves the SDK client in its default, 2025-era mode with the same tools", async () => {
    const legacy = new Client({ name: "vitest-legacy", version: "0" });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    expect(legacy.getInstructions()).toContain("evidence, not fact");
    expect((await legacy.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const r = (await legacy.callTool({ name: "mif_vault_get_concept", arguments: { concept: POLICY } })) as Called;
    expect(r.structuredContent).toMatchObject({ concept: { id: POLICY } });
    await legacy.close();
  });

  it("still serves a 2025-era client that starts with initialize", async () => {
    const r = await raw(endpoint.port, {
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "0" } } }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain("mif-vault");
    expect(r.body).toContain("evidence, not fact");
  });
});

const note = (n: number, extra = "") => `---
id: 00000000-0000-4000-8000-${String(n).padStart(12, "0")}
type: semantic
created: 2026-01-01T00:00:00Z
title: Note ${n}
${extra}---
# Note ${n}

Body ${n}.
`;
const noteId = (n: number) => `urn:mif:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function connect(v: Awaited<ReturnType<typeof vault>>) {
  const endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1", structured: true });
  const client = new Client({ name: "vitest", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Called;
  return { endpoint, client, call, close: async () => void (await client.close(), await endpoint.close()) };
}

describe("a note id carried by two notes", () => {
  it("is never resolved to one of them: tools and resources name both", async () => {
    // Both notes are in the same bundle, where the bundle's own id index keeps only one path per id.
    const v = await vault({ notes: { "a.md": note(1), "copy-of-a.md": note(1).replace("Note 1", "Copy of note 1"), "b.md": note(2) }, dot: {} });
    const c = await connect(v);
    const byId = await c.call("mif_vault_get_concept", { concept: noteId(1) });
    expect(byId.isError).toBe(true);
    expect(textOf(byId)).toContain("a.md — Note 1");
    expect(textOf(byId)).toContain("copy-of-a.md — Copy of note 1");
    expect((await c.call("mif_vault_get_concept", { concept: "a.md" })).isError).toBeFalsy();
    await expect(c.client.readResource({ uri: noteId(1) })).rejects.toThrow(/more than one note: a\.md.*copy-of-a\.md/);
    const graph = await c.call("mif_vault_get_status", {});
    expect((graph.structuredContent!.graph as { duplicate_ids: unknown }).duplicate_ids).toEqual([{ id: noteId(1), paths: ["a.md", "copy-of-a.md"] }]);
    expect(textOf(graph)).toContain(`1 id(s) are carried by more than one note`);
    expect((await c.call("mif_vault_get_concept", { concept: noteId(2) })).isError).toBeFalsy();
    await c.close();
  });
});

describe("a vault with several bundles", () => {
  const notes: Record<string, string> = { "a/one.md": note(1), "b/two.md": note(2), "b/same-as-one.md": note(1).replace("Note 1", "Same id as one") };
  for (let n = 100; n < 100 + RESOURCE_PAGE + 5; n++) notes[`a/many/n${n}.md`] = note(n);
  const hit = (n: number, cosine: number, path: string) => ({ id: noteId(n), score: cosine / 10, cosine, bm25: null, path, title: `Note ${n}`, entity_type: null, concept_type: "semantic", heading: null, text: `Note ${n}`, span: null });
  // Each bundle's store answers with its own documents; the scores are only comparable by cosine.
  const search = (args: string[]) => JSON.stringify({ matches: args.includes("a/.mif/vectors.db") ? [hit(100, 0.9, "many/n100.md"), hit(101, 0.3, "many/n101.md")] : [hit(2, 0.6, "two.md")] });
  const open = () => vault({ notes, roots: ["a", "b"], dot: { "a/.mif/vectors.db": "db", "b/.mif/vectors.db": "db" }, search });

  it("searches every bundle and merges by cosine, or one bundle on request", async () => {
    const c = await connect(await open());
    const all = await c.call("mif_vault_search_concepts", { query: "note" });
    expect((all.structuredContent!.results as Array<{ id: string; cosine: number; concept: { bundle: string } }>).map((h) => [h.id, h.cosine, h.concept.bundle])).toEqual([
      [noteId(100), 0.9, "a"],
      [noteId(2), 0.6, "b"],
      [noteId(101), 0.3, "a"],
    ]);
    const one = await c.call("mif_vault_search_concepts", { query: "note", bundle: "b" });
    expect((one.structuredContent!.results as Array<{ id: string }>).map((h) => h.id)).toEqual([noteId(2)]);
    expect((await c.call("mif_vault_search_concepts", { query: "note", bundle: "c" })).isError).toBe(true);
    const tools = (await c.client.listTools()).tools;
    expect((tools.find((t) => t.name === "mif_vault_search_concepts")!.inputSchema.properties as Record<string, { examples?: string[] }>).bundle!.examples).toEqual(["a", "b"]);
    await c.close();
  });

  it("names both notes when the same id is in two bundles, and reports each bundle's store", async () => {
    const c = await connect(await open());
    const twice = await c.call("mif_vault_get_concept", { concept: noteId(1) });
    expect(twice.isError).toBe(true);
    expect(textOf(twice)).toContain("a/one.md — Note 1");
    expect(textOf(twice)).toContain("b/same-as-one.md — Same id as one");
    const graph = await c.call("mif_vault_get_status", { bundle: "b" });
    expect(graph.structuredContent!.graph).toMatchObject({ bundles: ["b"], concepts: 2, duplicate_ids: [{ id: noteId(1), paths: ["a/one.md", "b/same-as-one.md"] }] });
    const store = await c.call("mif_vault_get_status", { report: "store" });
    expect((store.structuredContent!.stores as Array<{ bundle: string }>).map((s) => s.bundle)).toEqual(["a", "b"]);
    expect((await c.call("mif_vault_get_status", { report: "gaps" })).isError).toBe(true);
    await c.close();
  });

  it("pages through the resource list with a cursor", async () => {
    const c = await connect(await open());
    type Page = { result: { resources: Array<{ uri: string }>; nextCursor?: string } };
    const page = async (cursor?: string) => (JSON.parse((await raw(c.endpoint.port, modern("resources/list", cursor ? { cursor } : {}))).body) as Page).result;
    const first = await page();
    expect(first.resources).toHaveLength(RESOURCE_PAGE);
    expect(first.nextCursor).toBeDefined();
    const second = await page(first.nextCursor);
    expect(second.nextCursor).toBeUndefined();
    const uris = [...first.resources, ...second.resources].map((r) => r.uri);
    // 105 notes under a/many, a/one, and the two notes of b; the id two notes share is listed for each.
    expect(uris).toHaveLength(RESOURCE_PAGE + 5 + 3);
    expect(new Set(uris).size).toBe(RESOURCE_PAGE + 5 + 2);
    // The SDK's client follows the cursor itself and returns every page.
    expect((await c.client.listResources()).resources.map((r) => r.uri)).toEqual(uris);
    await c.close();
  });
});

describe("ontologies no concept gives a uri", () => {
  const local = (id: string, extra = "") => `ontology:\n  id: ${id}\n  version: 2.0.0\nentity_types:\n  - name: thing\n    base: semantic\n${extra}`;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const entry = (id: string, text: string) => ({ file: `${id}.ontology.yaml`, sha256: sha(text), version: "2.0.0", yaml: `https://mif-spec.dev/ontologies/${id}.ontology.yaml`, extends: [], canonical: `https://mif-spec.dev/ontologies/${id}.ontology.jsonld` });
  // The catalog publishes "as-published" and "edited-here"; the bundle's copy of the second has been changed. "only-local" is the bundle's own.
  const catalog = JSON.stringify({ aliases: { latest: "0.4.0" }, ontologies: { "as-published": entry("as-published", local("as-published")), "edited-here": entry("edited-here", local("edited-here")) } });
  const dot = {
    ".mif/ontologies/as-published.ontology.yaml": local("as-published"),
    ".mif/ontologies/edited-here.ontology.yaml": local("edited-here", "  - name: added-locally\n    base: semantic\n"),
    ".mif/ontologies/only-local.ontology.yaml": local("only-local"),
  };
  const PUBLISHED = "https://mif-spec.dev/ontologies/as-published.ontology.jsonld";

  it("are all served at urn:mif:ontology:<id>, and say where they are published when the copy is the catalog's own", async () => {
    // The catalog is already cached in the plugin folder; no concept declares an ontology uri.
    const c = await connect(await vault({ notes: { "a.md": note(1) }, dot: { ...dot, ".obsidian/plugins/mif/ontology-cache/index.json": catalog } }));
    const listed = (await c.client.listResources()).resources.map((r) => r.uri);
    expect(listed).toEqual([noteId(1), "urn:mif:ontology:as-published", "urn:mif:ontology:edited-here", "urn:mif:ontology:only-local"]);
    // The address an ontology is published at is information, not a resource: nothing is served there.
    await expect(c.client.readResource({ uri: PUBLISHED })).rejects.toThrow();
    const read = async (uri: string) => JSON.parse(((await c.client.readResource({ uri })).contents[0] as { text: string }).text);
    expect(await read("urn:mif:ontology:as-published")).toMatchObject({ id: "as-published", version: "2.0.0", uri: "urn:mif:ontology:as-published", published_at: PUBLISHED, address: "catalog" });
    // An edited copy is not what the catalog's address names, so it is not served there.
    expect(await read("urn:mif:ontology:edited-here")).toMatchObject({ id: "edited-here", address: "local", address_note: "This copy differs from the one the mif-spec.dev catalog publishes under the same id." });
    await expect(c.client.readResource({ uri: "https://mif-spec.dev/ontologies/edited-here.ontology.jsonld" })).rejects.toThrow();
    expect(await read("urn:mif:ontology:only-local")).toMatchObject({ id: "only-local", address: "local", address_note: "Not listed in the mif-spec.dev catalog, or the catalog is not known." });
    expect((await read("urn:mif:ontology:edited-here")).entity_types.map((t: { name: string }) => t.name)).toEqual(["thing", "added-locally"]);
    await expect(c.client.readResource({ uri: "urn:mif:ontology:nope" })).rejects.toThrow(/No ontology is addressed/);
    const graph = await c.call("mif_vault_get_status", {});
    expect((graph.structuredContent!.graph as { ontologies: Array<{ id: string; address: string }> }).ontologies.map((o) => [o.id, o.address])).toEqual([
      ["as-published", "catalog"],
      ["edited-here", "local"],
      ["only-local", "local"],
    ]);
    expect(textOf(graph)).toContain("  - edited-here 2.0.0 — urn:mif:ontology:edited-here (This copy differs");
    const done = await c.client.complete({ ref: { type: "ref/resource", uri: RESOURCE_TEMPLATE }, argument: { name: "id", value: "ontology:" } });
    expect(done.completion.values).toEqual(["ontology:as-published", "ontology:edited-here", "ontology:only-local"]);
    await c.close();
  });

  it("learn the catalog when the server starts, if downloads are allowed; until then every one is addressed locally", async () => {
    network.clear();
    network.set(CATALOG_URL, catalog);
    const addresses = (v: Awaited<ReturnType<typeof vault>>) => v.host.ontologies().map((o) => [o.id, o.address]);
    const allowed = await vault({ notes: { "a.md": note(1) }, dot, settings: { downloadOntologies: true } });
    expect(addresses(allowed)).toEqual([["as-published", "local"], ["edited-here", "local"], ["only-local", "local"]]);
    await allowed.host.prepare();
    expect(addresses(allowed)).toEqual([["as-published", "catalog"], ["edited-here", "local"], ["only-local", "local"]]);
    expect(allowed.host.ontologies()[0]).toMatchObject({ uri: "urn:mif:ontology:as-published", published_at: PUBLISHED });
    expect(allowed.dotFiles.has(".obsidian/plugins/mif/ontology-cache/index.json")).toBe(true);
    // Downloads off: no request is made.
    network.clear();
    const refused = await vault({ notes: { "a.md": note(1) }, dot, settings: { downloadOntologies: false } });
    await refused.host.prepare();
    expect(addresses(refused).every(([, a]) => a === "local")).toBe(true);
    // The network failing is not fatal either.
    const offline = await vault({ notes: { "a.md": note(1) }, dot, settings: { downloadOntologies: true } });
    await offline.host.prepare();
    expect(addresses(offline).every(([, a]) => a === "local")).toBe(true);
    expect(offline.host.ontologies().map((o) => o.uri)).toEqual(["urn:mif:ontology:as-published", "urn:mif:ontology:edited-here", "urn:mif:ontology:only-local"]);
  });
});

describe("the settings switch", () => {
  it("reads on only while the server is wanted and its start did not fail", () => {
    expect(mcpServing(true, { state: "running", url: "http://127.0.0.1:1/mcp" })).toBe(true);
    expect(mcpServing(true, { state: "off" })).toBe(true); // wanted, start not finished yet
    expect(mcpServing(true, { state: "failed", reason: "Port in use" })).toBe(false);
    expect(mcpServing(false, { state: "off" })).toBe(false);
  });

  it("corrects the display without that correction being taken for a click", () => {
    // Like Obsidian's toggle: setting the value from code calls the change handler.
    let enabled = true;
    let handled = 0;
    const toggle = {
      on: true,
      getValue() {
        return this.on;
      },
      setValue(v: boolean) {
        this.on = v;
        if (mirror.showing) return;
        handled++;
        enabled = v;
      },
    };
    const mirror = new SwitchMirror(toggle);
    mirror.show(false); // the start failed: show off
    expect(toggle.on).toBe(false);
    expect(enabled).toBe(true); // the setting is still on, so a free port starts the server
    expect(handled).toBe(0);
    mirror.show(false); // already showing: nothing to do
    mirror.show(true); // a free port was entered and the server started
    expect(toggle.on).toBe(true);
    expect(handled).toBe(0);
    expect(mirror.showing).toBe(false);
    toggle.setValue(false); // the user's own click still counts
    expect(enabled).toBe(false);
    expect(handled).toBe(1);
  });
});

describe("search without a vector store", () => {
  it("says search is unavailable and what to use instead", async () => {
    const v = await vault({ store: false });
    const endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1", structured: true });
    const client = new Client({ name: "vitest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const r = (await client.callTool({ name: "mif_vault_search_concepts", arguments: { query: "anything" } })) as Called;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Nothing ingested yet");
    expect(textOf(r)).toContain("mif_vault_get_concept");
    await client.close();
    await endpoint.close();
  });
});

describe("McpService", () => {
  it("stays off until enabled, and leaves a taken port alone", async () => {
    const v = await vault();
    const settings = { ...v.settings, mcpToken: TOKEN, mcpPort: 0 };
    const service = new McpService(v.host, () => settings, () => http, () => ({ startEndpoint }), "0.0.1");
    expect(await service.sync()).toEqual({ state: "off" });
    settings.mcpEnabled = true;
    expect((await service.sync()).state).toBe("failed"); // port 0 is not a port a client can be told
    const taken = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0" });
    settings.mcpPort = taken.port;
    const clash = await service.sync();
    expect(clash).toMatchObject({ state: "failed" });
    expect((clash as { reason: string }).reason).toContain("already in use");
    await taken.close();
    const up = await service.sync();
    expect(up).toEqual({ state: "running", url: `http://127.0.0.1:${taken.port}/mcp` });
    settings.mcpEnabled = false;
    expect(await service.sync()).toEqual({ state: "off" });
    await expect(raw(taken.port, { headers: {} })).rejects.toThrow();
    const mobile = new McpService(v.host, () => ({ ...settings, mcpEnabled: true, mcpPort: 27182 }), () => undefined, () => ({ startEndpoint }), "0.0.1");
    expect(await mobile.sync()).toMatchObject({ state: "failed", reason: "The MCP server is desktop only." });
    // The server code is a separate file; without it the server says so and stays off.
    const noCode = new McpService(v.host, () => ({ ...settings, mcpEnabled: true, mcpPort: 27182 }), () => http, () => undefined, "0.0.1");
    const missing = await noCode.sync();
    expect(missing.state).toBe("failed");
    expect((missing as { reason: string }).reason).toContain("mcp.cjs");
    await service.dispose();
  });
});

// --- Phase 2: writes ---------------------------------------------------------------------

const ASKING = { ...META, "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } };
/** A tool call from a client that can ask its user, as raw HTTP: the result, whatever its kind. */
async function asking(port: number, name: string, args: Record<string, unknown>, inputResponses?: Record<string, unknown>) {
  const m = modern("tools/call", { name, arguments: args, ...(inputResponses ? { inputResponses } : {}) }, name);
  const body = JSON.stringify({ ...(JSON.parse(m.body) as { params: Record<string, unknown> }), params: { name, arguments: args, ...(inputResponses ? { inputResponses } : {}), _meta: ASKING } });
  const r = await raw(port, { headers: m.headers, body });
  const data = r.body.startsWith("{") ? r.body : r.body.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return (JSON.parse(data) as { result: Called & { resultType?: string; inputRequests?: Record<string, { params?: { message?: string } }> } }).result;
}

describe("writes", () => {
  const [W_CONCEPT, W_REL, W_REF, W_INGEST, W_EDIT] = WRITE_TOOL_NAMES;
  // The fake search always finds the policy at cosine 0.71; the duplicate floor is above it except where a test lowers it.
  const on = (extra: Partial<MifSettings> = {}) => vault({ settings: { mcpAllowWrites: true, duplicateThreshold: 0.9, ...extra } });

  it("are not offered until the vault allows them, and appear when it does, without a restart", async () => {
    const v = await vault();
    const c = await connect(v);
    expect((await c.client.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect((await c.client.listPrompts()).prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
    expect(guide(v.host)).toContain("does not allow writes");
    await expect(c.call(W_CONCEPT, { operation: "create", title: "X", body: "x", type: "semantic" })).rejects.toThrow(/not found/);
    v.settings.mcpAllowWrites = true;
    // The first client may keep its cached list until it is told the list changed; a client that asks afresh sees the new one.
    const fresh = new Client({ name: "vitest", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await fresh.connect(new StreamableHTTPClientTransport(new URL(c.endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const { tools } = await fresh.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    for (const t of tools.filter((t) => (WRITE_TOOL_NAMES as readonly string[]).includes(t.name))) {
      expect(t.name).toMatch(/^mif_vault_[a-z_]+$/);
      expect(OTHER_SERVERS).not.toContain(t.name);
      expect(OTHER_SERVERS).not.toContain(t.name.replace(/^mif_vault_/, ""));
      expect(t.annotations).toMatchObject({ readOnlyHint: false });
      expect(t.outputSchema).toBeDefined();
      expect(t.description).toMatch(/evidence|freshness/);
    }
    expect(tools.find((t) => t.name === W_INGEST)!.annotations).toMatchObject({ openWorldHint: true, destructiveHint: false });
    expect((await fresh.listPrompts()).prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES, ...WRITE_PROMPT_NAMES]);
    const g = guide(v.host);
    for (const name of WRITE_TOOL_NAMES) expect(g).toContain(name);
    const p = await fresh.getPrompt({ name: WRITE_PROMPT_NAMES[0], arguments: { what: "We chose 100 rpm." } });
    expect(JSON.stringify(p.messages)).toContain(W_CONCEPT);
    await fresh.close();
    await c.close();
  });

  it("creates a concept whole, linked and cited, marked agent-written and unverified under the client's name", async () => {
    const v = await on();
    const c = await connect(v);
    notices.length = 0;
    const r = await c.call(W_CONCEPT, {
      operation: "create", title: "Burst Allowance", type: "semantic", body: "Bursts of 20 requests are allowed.\n\n## Why\n\nShort spikes are normal.", summary: "Bursts of 20 are allowed.",
      relationships: [{ type: "relates-to", target: "API Rate Limit Policy" }], citations: [{ title: "Gateway manual", url: "https://example.test/manual" }],
      entities: [{ urn: "urn:mif:entity:policy:rate-limit", name: "Rate limit" }],
    });
    expect(textOf(r)).toContain("Created Burst Allowance [semantic/Burst-Allowance.md]");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ operation: "create", changed: ["semantic/Burst-Allowance.md"], concept: { path: "semantic/Burst-Allowance.md", title: "Burst Allowance" } });
    expect(textOf(r)).toContain("trust: uncertain");
    const text = v.mem.texts.get("semantic/Burst-Allowance.md")!;
    expect(text).toMatch(/sourceType: agent_inferred/);
    expect(text).toMatch(/trustLevel: uncertain/);
    expect(text).toMatch(/agent: vitest/);
    expect(text).toContain("target: /semantic/rate-limit-policy.md");
    expect(text).toContain("## Why");
    expect(text).toContain("- relates-to [API Rate Limit Policy]");
    expect(text).toContain("Gateway manual");
    expect(text).toContain("urn:mif:entity:policy:rate-limit");
    // It is in the graph at once, and in the review queue.
    const rels = await c.call("mif_vault_list_relationships", { concept: POLICY_PATH, direction: "incoming" });
    expect(textOf(rels)).toContain("Burst Allowance");
    const status = await c.call("mif_vault_get_status", { report: "graph" });
    expect((status.structuredContent as { graph: { awaiting_review: number } }).graph.awaiting_review).toBe(2);
    expect(v.host.reviewItems().map((i) => [i.concept.path, i.agent])).toContainEqual(["semantic/Burst-Allowance.md", "vitest 0"]);
    expect(notices.some((n) => n.includes("vitest") && n.includes("Burst Allowance"))).toBe(true);
    await vi.waitFor(() => expect([...v.dotFiles].find(([k]) => k.endsWith(AUDIT_LOG))?.[1]).toMatch(/vitest 0\tcreate-concept\tsemantic\/Burst-Allowance\.md\tdone/));
    // A second concept of the same title gets its own file; nothing is overwritten.
    const again = await c.call(W_CONCEPT, { operation: "create", title: "Burst Allowance", type: "semantic", body: "Again.", on_duplicate: "create" });
    expect((again.structuredContent as { concept: { path: string } }).concept.path).not.toBe("semantic/Burst-Allowance.md");
    await c.close();
  });

  it("refuses what would not be valid MIF, a missing type, and an unknown target, and writes nothing", async () => {
    const v = await on();
    const c = await connect(v);
    const before = v.mem.texts.size;
    expect(textOf(await c.call(W_CONCEPT, { operation: "create", title: "No type", body: "x" }))).toContain('needs type');
    expect((await c.call(W_CONCEPT, { operation: "create", title: "Bad", type: "semantic", body: "x", relationships: [{ type: "relates-to", target: "No Such Concept" }] })).isError).toBe(true);
    expect((await c.call(W_CONCEPT, { operation: "create", title: "Bad date", type: "semantic", body: "x", valid_until: "next week" })).isError).toBe(true);
    expect(v.mem.texts.size).toBe(before);
    await c.close();
  });

  it("asks about a near-duplicate: by elicitation when the client can ask, by an error naming the choices when it cannot", async () => {
    const v = await on({ duplicateThreshold: 0.7 });
    const c = await connect(v);
    const args = { operation: "create", title: "Rate Limits", type: "semantic", body: "100 per minute." };
    const told = await c.call(W_CONCEPT, args);
    expect(told.isError).toBe(true);
    expect(textOf(told)).toContain("API Rate Limit Policy (cosine 0.71)");
    expect(textOf(told)).toMatch(/create[\s\S]*supersede[\s\S]*cancel[\s\S]*on_duplicate/);
    expect(textOf(told)).toContain("merge");
    // "merge" writes nothing and says how: read the existing concept, then edit it with the combined text.
    const merge = await c.call(W_CONCEPT, { ...args, on_duplicate: "merge" });
    expect(merge.isError).toBeFalsy();
    expect(merge.structuredContent).toMatchObject({ operation: "merge_needed", changed: [], concept: { path: POLICY_PATH } });
    expect(textOf(merge)).toMatch(/mif_vault_get_concept[\s\S]*mif_vault_edit_concept/);
    expect(v.mem.texts.has("semantic/Rate-Limits.md")).toBe(false);
    const cancelled = await c.call(W_CONCEPT, { ...args, on_duplicate: "cancel" });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.structuredContent).toMatchObject({ operation: "cancelled", changed: [] });
    expect(v.mem.texts.has("semantic/Rate-Limits.md")).toBe(false);

    const asked = await asking(c.endpoint.port, W_CONCEPT, args);
    expect(asked.resultType).toBe("input_required");
    expect(JSON.stringify(asked.inputRequests)).toContain("API Rate Limit Policy");
    const declined = await asking(c.endpoint.port, W_CONCEPT, args, { duplicate: { action: "decline" } });
    expect(declined.isError).toBe(true);
    expect(v.mem.texts.has("semantic/Rate-Limits.md")).toBe(false);
    const replaced = await asking(c.endpoint.port, W_CONCEPT, args, { duplicate: { action: "accept", content: { choice: "supersede" } } });
    expect(replaced.isError).toBeFalsy();
    expect(replaced.structuredContent).toMatchObject({ operation: "supersede", superseded: { path: POLICY_PATH } });
    expect(v.mem.texts.get("semantic/Rate-Limits.md")).toMatch(/agent: raw-test/);
    await c.close();
  });

  it("supersedes with the user's agreement: the old concept is kept with its validity ended, and the new one points at it", async () => {
    const v = await on();
    const c = await connect(v);
    const args = { operation: "supersede", supersedes: POLICY, title: "API Rate Limit Policy v2", body: "200 per minute." };
    const unasked = await c.call(W_CONCEPT, args);
    expect(unasked.isError).toBe(true);
    expect(textOf(unasked)).toContain("confirm: true");
    expect((await asking(c.endpoint.port, W_CONCEPT, args)).resultType).toBe("input_required");
    expect((await asking(c.endpoint.port, W_CONCEPT, args, { confirm: { action: "accept", content: { confirm: false } } })).isError).toBe(true);
    expect(v.mem.texts.get(POLICY_PATH)).not.toMatch(/validUntil/);
    const r = await c.call(W_CONCEPT, { ...args, confirm: true });
    expect(textOf(r)).toContain("supersedes API Rate Limit Policy");
    expect(r.isError).toBeFalsy();
    const path = (r.structuredContent as { concept: { path: string } }).concept.path;
    expect(path).toBe("semantic/API-Rate-Limit-Policy-v2.md");
    expect(v.mem.texts.get(path)).toMatch(/type: supersedes\n\s+target: \.?\/?(semantic\/)?rate-limit-policy\.md|type: supersedes/);
    expect(v.mem.texts.get(path)).toMatch(/type: semantic/);
    // It takes over what the old concept declared, with strength, and says so.
    expect(textOf(r)).toMatch(/took over \d+ relationship\(s\) that API Rate Limit Policy declared/);
    expect(v.mem.texts.get(path)).toMatch(/type: derived-from\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md\n\s+strength: 0\.9/);
    expect(v.mem.texts.get(path)).toContain("- derived-from [Rate Spike Incident 2026-01]");
    expect(v.mem.texts.get(path)!.match(/type: supersedes/g)).toHaveLength(1);
    expect(v.mem.texts.get(POLICY_PATH)).toMatch(/validUntil: /);
    const old = await c.call("mif_vault_get_concept", { concept: POLICY_PATH });
    expect(textOf(old)).toMatch(/expired/i);
    // Rejecting the new concept in review moves it to the trash and makes the old one valid again.
    expect(await v.host.reject(path)).toBe(true);
    expect(v.mem.trashed).toContain(path);
    expect(v.mem.texts.get(POLICY_PATH)).not.toMatch(/validUntil/);
    await c.close();
  });

  it("reads a superseded title as the concept that is valid now, names the one set aside, and reads the old one at an earlier date", async () => {
    const v = await on();
    const c = await connect(v);
    // The replacement keeps the title, as a record that keeps its code would.
    const r = await c.call(W_CONCEPT, { operation: "supersede", supersedes: POLICY, title: "API Rate Limit Policy", body: "200 per minute.", confirm: true });
    const fresh = (r.structuredContent as { concept: { path: string } }).concept.path;
    const now = await c.call("mif_vault_get_concept", { concept: "API Rate Limit Policy" });
    expect(now.isError).toBeFalsy();
    expect(now.structuredContent).toMatchObject({ concept: { path: fresh }, set_aside: [POLICY_PATH] });
    expect(textOf(now)).toContain("1 other concept(s) carry this title or code and are expired");
    expect(textOf(now)).toContain(POLICY_PATH);
    // A path or an id always names its own note.
    expect((await c.call("mif_vault_get_concept", { concept: POLICY_PATH })).structuredContent).toMatchObject({ concept: { path: POLICY_PATH } });
    expect((await c.call("mif_vault_get_concept", { concept: POLICY })).structuredContent).not.toHaveProperty("set_aside");
    // Before the replacement existed, the title means the old one.
    const then = await c.call("mif_vault_get_concept", { concept: "API Rate Limit Policy", as_of: "2026-03-01" });
    expect(then.structuredContent).toMatchObject({ concept: { path: POLICY_PATH }, set_aside: [fresh] });
    // Two concepts of one title that are both valid stay ambiguous.
    await c.call(W_CONCEPT, { operation: "create", title: "API Rate Limit Policy", type: "semantic", body: "A third.", on_duplicate: "create" });
    const both = await c.call("mif_vault_get_concept", { concept: "API Rate Limit Policy" });
    expect(both.isError).toBe(true);
    await c.close();
  });

  it("adds, changes and removes a typed relationship in the frontmatter and its mirrored section only", async () => {
    const v = await on();
    const c = await connect(v);
    const prose = (t: string) => t.split("\n---\n")[1]!.split("## Relationships")[0];
    const before = v.mem.texts.get(RUNBOOK_PATH)!;
    const added = await c.call(W_REL, { operation: "add", from: RUNBOOK, target: INCIDENT, type: "derived-from", strength: 0.6 });
    expect(textOf(added)).toContain("derived-from");
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent).toMatchObject({ operation: "add", changed: [RUNBOOK_PATH] });
    let text = v.mem.texts.get(RUNBOOK_PATH)!;
    expect(text).toContain("type: derived-from");
    expect(text).toContain("- derived-from [");
    expect(prose(text)).toBe(prose(before));
    expect((await c.call(W_REL, { operation: "add", from: RUNBOOK, target: INCIDENT, type: "derived-from" })).isError).toBe(true);
    expect((await c.call(W_REL, { operation: "add", from: RUNBOOK, target: RUNBOOK, type: "relates-to" })).isError).toBe(true);

    // No type: the user chooses, or the agent is told the choices.
    const untyped = await c.call(W_REL, { operation: "add", from: INCIDENT, target: RUNBOOK });
    expect(untyped.isError).toBe(true);
    expect(textOf(untyped)).toContain("relates-to");
    const asked = await asking(c.endpoint.port, W_REL, { operation: "add", from: INCIDENT, target: RUNBOOK });
    expect(asked.resultType).toBe("input_required");
    const picked = await asking(c.endpoint.port, W_REL, { operation: "add", from: INCIDENT, target: RUNBOOK }, { type: { action: "accept", content: { choice: "relates-to" } } });
    expect(picked.isError).toBeFalsy();
    expect(v.mem.texts.get(INCIDENT_PATH)).toContain("rotate-api-keys.md");

    // Update and remove need the user's agreement.
    const change = { operation: "update", from: RUNBOOK, target: INCIDENT, type: "derived-from", new_type: "relates-to", strength: 0.9 };
    expect(textOf(await c.call(W_REL, change))).toContain("confirm: true");
    expect((await c.call(W_REL, { ...change, confirm: true })).isError).toBeFalsy();
    text = v.mem.texts.get(RUNBOOK_PATH)!;
    expect(text).not.toContain("type: derived-from");
    expect(text).toContain("strength: 0.9");
    expect((await c.call(W_REL, { operation: "remove", from: RUNBOOK, target: INCIDENT, type: "derived-from", confirm: true })).isError).toBe(true);
    const removed = await asking(c.endpoint.port, W_REL, { operation: "remove", from: RUNBOOK, target: INCIDENT, type: "relates-to" }, { confirm: { action: "accept", content: { confirm: true } } });
    expect(removed.isError).toBeFalsy();
    expect(v.mem.texts.get(RUNBOOK_PATH)).not.toContain("incident-2026-01-rate-spike.md");
    expect(prose(v.mem.texts.get(RUNBOOK_PATH)!)).toBe(prose(before));
    await c.close();
  });

  it("never writes a note that is open with unsaved edits, and says to try again", async () => {
    const v = await on();
    const c = await connect(v);
    const before = v.mem.texts.get(RUNBOOK_PATH)!;
    const ws = v.mem.app.workspace;
    ws.views.push(new MarkdownView(v.mem.files.get(RUNBOOK_PATH)!, `${before}\nunsaved`));
    const r = await c.call(W_REL, { operation: "add", from: RUNBOOK, target: INCIDENT, type: "relates-to" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unsaved edits");
    expect(v.mem.texts.get(RUNBOOK_PATH)).toBe(before);
    ws.views.length = 0;
    ws.active = new MarkdownView(v.mem.files.get(POLICY_PATH)!, v.mem.texts.get(POLICY_PATH)!);
    expect((await c.call(W_CONCEPT, { operation: "supersede", supersedes: POLICY, title: "P2", body: "x", confirm: true })).isError).toBe(true);
    expect(v.mem.texts.has("semantic/P2.md")).toBe(false);
    ws.active = null;
    await c.close();
  });

  it("adds a citation, records an entity, and adds an entity reference by urn or by name", async () => {
    const v = await on();
    const c = await connect(v);
    const cited = await c.call(W_REF, { operation: "add_citation", concept: RUNBOOK, citation: { title: "Key rotation guide", url: "https://example.test/keys", type: "article" } });
    expect(textOf(cited)).toContain('now cites "Key rotation guide"');
    expect(cited.isError).toBeFalsy();
    expect(v.mem.texts.get(RUNBOOK_PATH)).toContain("https://example.test/keys");
    expect((await c.call(W_REF, { operation: "add_citation", concept: RUNBOOK, citation: { title: "Key rotation guide", url: "https://example.test/keys" } })).isError).toBe(true);
    expect((await c.call(W_REF, { operation: "add_citation", concept: RUNBOOK })).isError).toBe(true);

    const made = await c.call(W_REF, { operation: "create_entity", entity: { name: "Ada Lovelace", type: "person" } });
    expect(textOf(made)).toContain("urn:mif:entity:person:ada-lovelace");
    expect(made.structuredContent).toMatchObject({ urn: "urn:mif:entity:person:ada-lovelace", created: true });
    expect(v.dotFiles.has(".mif/entities/person/ada-lovelace.yaml")).toBe(true);
    expect((await c.call(W_REF, { operation: "create_entity", entity: { name: "Ada Lovelace", type: "person" } })).structuredContent).toMatchObject({ created: false });

    // Only a type the bundle has: a core type, or one its ontologies define.
    const unknown = await c.call(W_REF, { operation: "create_entity", entity: { name: "Edge Gateway", type: "appliance" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/not an entity type of this bundle[\s\S]*Person, Organization, Technology, Concept, File, guide, how-to-guide[\s\S]*mif_vault_list_entity_types/);
    expect([...v.dotFiles.keys()].some((k) => k.includes("appliance"))).toBe(false);
    expect((await c.call(W_REF, { operation: "create_entity", entity: { name: "Key Rotation", type: "How-To Guide" } })).structuredContent).toMatchObject({ urn: "urn:mif:entity:how-to-guide:key-rotation", created: true });

    const byName = await c.call(W_REF, { operation: "add_entity_reference", concept: RUNBOOK, entity: { name: "ada lovelace", role: "author" } });
    expect(textOf(byName)).toContain("urn:mif:entity:person:ada-lovelace");
    expect(byName.isError).toBeFalsy();
    expect(v.mem.texts.get(RUNBOOK_PATH)).toContain("urn:mif:entity:person:ada-lovelace");
    expect((await c.call(W_REF, { operation: "add_entity_reference", concept: RUNBOOK, entity: { urn: "urn:mif:entity:person:ada-lovelace" } })).isError).toBe(true);
    expect(textOf(await c.call(W_REF, { operation: "add_entity_reference", concept: RUNBOOK, entity: { name: "Nobody Known" } }))).toContain("create_entity");
    await c.close();
  });

  it("lists the entity types an entity may be recorded as: the core ones and those the ontologies define", async () => {
    const v = await vault();
    const c = await connect(v);
    const all = await c.call("mif_vault_list_entity_types", {});
    const types = (all.structuredContent as { entity_types: Array<{ name: string; slug: string; source: string; base?: string; subtype_of: string[]; entities: number; concepts: number }> }).entity_types;
    expect(types.map((t) => t.name)).toEqual(["Person", "Organization", "Technology", "Concept", "File", "guide", "how-to-guide"]);
    expect(types.find((t) => t.name === "Person")).toMatchObject({ slug: "person", source: "core" });
    expect(types.find((t) => t.name === "how-to-guide")).toMatchObject({ source: "gateway-ops", base: "procedural", subtype_of: ["guide"], concepts: 1 });
    expect(textOf(all)).toContain('how-to-guide (urn segment "how-to-guide") — ontology gateway-ops, procedural, subtype of guide');
    const core = await c.call("mif_vault_list_entity_types", { source: "core", name_contains: "org" });
    expect(core.structuredContent).toMatchObject({ count: 1, entity_types: [{ name: "Organization" }] });
    expect((await c.call("mif_vault_list_entity_types", { bundle: "nope" })).isError).toBe(true);
    await c.close();
  });

  it("edits a concept's text, whole or by section, keeps the mirrored sections, and sends it back to review", async () => {
    const v = await on();
    const c = await connect(v);
    expect(v.host.reviewQueue().map((r) => r.path)).toEqual(["semantic/old-limit.md"]);
    const section = await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, section: "Steps", text: "1. Revoke the key.\n2. Issue a new one." });
    expect(textOf(section)).toContain('Edited Rotate API Keys [procedural/rotate-api-keys.md]: its "Steps" section.');
    expect(section.isError).toBeFalsy();
    let text = v.mem.texts.get(RUNBOOK_PATH)!;
    expect(text).toContain("How-to knowledge: rotate an API key");
    expect(text).toContain("## Steps\n\n1. Revoke the key.\n2. Issue a new one.\n");
    expect(text).not.toContain("Identify the key ID");
    expect(text).toContain("## Relationships\n\n- relates-to [API Rate Limit Policy](/semantic/rate-limit-policy.md)");
    expect(text).toMatch(/---\n\n# Rotate API Keys\n/);
    // A human-written concept an agent edited is unverified again, under the client's name.
    expect(text).toMatch(/trustLevel: uncertain/);
    expect(text).toMatch(/agent: vitest/);
    expect(text).toMatch(/sourceRef: mcp:mif-vault/);
    expect(text).toMatch(/modified: /);
    expect(v.host.reviewQueue().map((r) => r.path)).toContain(RUNBOOK_PATH);
    expect(textOf(section)).toContain("trust: uncertain");

    // The whole text: the note keeps its title heading, and a Relationships section the agent sends is ignored.
    const whole = await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, body: "Rotate a key that is compromised.\n\n## Relationships\n\n- relates-to [Nothing](/nothing.md)", summary: "How to rotate a key.", tags: ["runbook"] });
    expect(whole.isError).toBeFalsy();
    text = v.mem.texts.get(RUNBOOK_PATH)!;
    expect(text).toContain("# Rotate API Keys\n\nRotate a key that is compromised.");
    expect(text).not.toContain("nothing.md");
    expect(text).not.toContain("## Steps");
    expect(text).toContain("- relates-to [API Rate Limit Policy](/semantic/rate-limit-policy.md)");
    expect(text).toContain("summary: How to rotate a key.");
    expect(text).not.toContain("- security");
    // A section the concept lacks is added; the mirrored ones cannot be written.
    expect((await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, section: "Rollback", text: "Restore the old key." })).isError).toBeFalsy();
    expect(v.mem.texts.get(RUNBOOK_PATH)).toMatch(/## Rollback\n\nRestore the old key\.\n\n## Relationships/);
    expect(textOf(await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, section: "Relationships", text: "x" }))).toContain("written from the concept's frontmatter");
    expect((await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK })).isError).toBe(true);
    expect((await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, section: "Steps" })).isError).toBe(true);
    expect((await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, body: "x", section: "Steps", text: "y" })).isError).toBe(true);
    // Promoting it takes it out of review again.
    expect(await v.host.promote(RUNBOOK_PATH, "verified")).toBe(true);
    expect(v.host.reviewQueue().map((r) => r.path)).not.toContain(RUNBOOK_PATH);
    // Never while the note is open with unsaved edits.
    const before = v.mem.texts.get(RUNBOOK_PATH)!;
    v.mem.app.workspace.views.push(new MarkdownView(v.mem.files.get(RUNBOOK_PATH)!, `${before}\nunsaved`));
    expect(textOf(await c.call(W_EDIT, { operation: "edit", concept: RUNBOOK, body: "No." }))).toContain("unsaved edits");
    expect(v.mem.texts.get(RUNBOOK_PATH)).toBe(before);
    v.mem.app.workspace.views.length = 0;
    await c.close();
  });

  it("merges concepts into one: it takes the merged text and what they declared, and supersedes each, which is kept", async () => {
    const v = await on();
    const c = await connect(v);
    expect((await c.call(W_EDIT, { operation: "merge", concept: POLICY, merge_from: ["Old Rate Limit"] })).isError).toBe(true);
    expect((await c.call(W_EDIT, { operation: "merge", concept: POLICY, body: "x" })).isError).toBe(true);
    expect((await c.call(W_EDIT, { operation: "merge", concept: POLICY, merge_from: [POLICY], body: "x" })).isError).toBe(true);
    await c.call(W_REL, { operation: "add", from: "Old Rate Limit", target: INCIDENT, type: "derived-from", strength: 0.5 });
    await c.call(W_REL, { operation: "add", from: "Old Rate Limit", target: RUNBOOK, type: "documents", strength: 0.5 });
    const r = await c.call(W_EDIT, { operation: "merge", concept: POLICY, merge_from: ["Old Rate Limit"], body: "The limit is 100 requests per minute. Until 2026-02 it was 50." });
    expect(textOf(r)).toContain("Merged Old Rate Limit into API Rate Limit Policy [semantic/rate-limit-policy.md]");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ operation: "merge", changed: [POLICY_PATH, "semantic/old-limit.md"], concept: { path: POLICY_PATH }, merged: [{ path: "semantic/old-limit.md" }], warnings: [] });
    const text = v.mem.texts.get(POLICY_PATH)!;
    expect(text).toContain("# API Rate Limit Policy\n\nThe limit is 100 requests per minute. Until 2026-02 it was 50.");
    // What the merged concept declared is carried over; its relationship to the survivor is not.
    expect(text).toMatch(/type: documents\n\s+target: \/procedural\/rotate-api-keys\.md\n\s+strength: 0\.5/);
    // One the survivor already declares is not added a second time, and keeps its own strength.
    expect(text.match(/type: derived-from/g)).toHaveLength(1);
    expect(text).toMatch(/type: derived-from\n\s+target: \/episodic\/incident-2026-01-rate-spike\.md\n\s+strength: 0\.9/);
    expect(text).toMatch(/type: supersedes\n\s+target: \/semantic\/old-limit\.md/);
    expect(text).not.toMatch(/target: \/semantic\/rate-limit-policy\.md/);
    expect(text).toContain("Gateway manual");
    expect(text).toContain("urn:mif:entity:policy:rate-limit");
    expect(text).toContain("- supersedes [Old Rate Limit](/semantic/old-limit.md)");
    expect(text).toMatch(/trustLevel: uncertain/);
    expect(text).toMatch(/sourceRef: mcp:mif-vault/);
    // The merged concept is still there, as it was, already ended before the merge.
    expect(v.mem.texts.get("semantic/old-limit.md")).toContain("validUntil: 2026-02-01T00:00:00Z");
    expect(v.mem.trashed).toEqual([]);
    const rels = await c.call("mif_vault_list_relationships", { concept: POLICY_PATH, direction: "outgoing", include_expired: true });
    expect(textOf(rels)).toContain("supersedes");
    await c.close();
  });

  it("ingests through the plugin's mif-cli bridge, and counts as a write", async () => {
    const v = await on();
    const c = await connect(v);
    const r = await c.call(W_INGEST, {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ bundle: "" });
    expect(v.calls.some((a) => a[0] === "ingest" && a.includes("--changed-only"))).toBe(true);
    await c.close();
  });

  it("stops at the vault's write limit and says when to try again", async () => {
    const v = await on({ mcpWriteLimit: 2, mcpWriteWindowMinutes: 10 });
    const c = await connect(v);
    const cite = (n: number) => c.call(W_REF, { operation: "add_citation", concept: RUNBOOK, citation: { title: `Source ${n}`, url: `https://example.test/${n}` } });
    const first = await cite(1);
    expect(textOf(first)).toContain("now cites");
    expect(first.isError).toBeFalsy();
    expect((await cite(2)).isError).toBeFalsy();
    const third = await cite(3);
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/2 writes in 10 minutes[\s\S]*Try again in about \d+ minute/);
    expect(v.mem.texts.get(RUNBOOK_PATH)).not.toContain("Source 3");
    // Reads are not limited, and the limit clears as writes age out.
    expect((await c.call("mif_vault_get_concept", { concept: RUNBOOK })).isError).toBeFalsy();
    expect(v.host.admit()).toBeDefined();
    await c.close();
  });

  it("lets the user promote a reviewed concept to a trust level, keeping who wrote it", async () => {
    const v = await on();
    expect(v.host.reviewQueue().map((r) => r.path)).toEqual(["semantic/old-limit.md"]);
    expect(await v.host.promote("semantic/old-limit.md", "user_stated")).toBe(true);
    const text = v.mem.texts.get("semantic/old-limit.md")!;
    expect(text).toMatch(/trustLevel: user_stated/);
    expect(text).toMatch(/sourceType: agent_inferred/);
    expect(v.host.reviewQueue()).toEqual([]);
    expect(await v.host.promote("plain.md", "verified")).toBe(false);
    expect(await v.host.promote("semantic/old-limit.md", "uncertain" as never)).toBe(false);
  });
});

// --- Phase 3: live updates, curation prompts, tasks ---------------------------------------

/** Open a subscriptions/listen stream and collect what arrives on it. */
async function listen(port: number, notifications: Record<string, unknown>) {
  const m = modern("subscriptions/listen", { notifications });
  const seen: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: m.headers });
  const opened = new Promise<number>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const data = buffer.slice(0, end).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          buffer = buffer.slice(end + 2);
          if (data) seen.push(JSON.parse(data) as { method?: string });
        }
      });
      res.on("error", () => undefined);
      resolve(res.statusCode ?? 0);
    });
  });
  req.end(m.body);
  return { status: await opened, seen, methods: () => seen.map((s) => s.method), close: () => req.destroy() };
}

describe("live updates", () => {
  it("advertises that clients may listen for list changes and subscribe to resources", async () => {
    const v = await vault();
    const c = await connect(v);
    const d = await c.client.discover();
    expect(d.capabilities).toMatchObject({ tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true } });
    await c.close();
  });

  it("tells a listening client which concept changed, when the set of resources changes, and when writes are switched", async () => {
    const v = await vault();
    const settings = Object.assign(v.settings, { mcpEnabled: true, mcpToken: TOKEN, mcpPort: 0 });
    const free = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0" });
    settings.mcpPort = free.port;
    await free.close();
    const service = new McpService(v.host, () => settings, () => http, () => ({ startEndpoint }), "0.0.1");
    expect((await service.sync()).state).toBe("running");
    const stream = await listen(settings.mcpPort, { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: [POLICY] });
    expect(stream.status).toBe(200);
    await vi.waitFor(() => expect(stream.methods()).toContain("notifications/subscriptions/acknowledged"));

    // An edit to the subscribed concept; an edit to another concept is not told to this client.
    const edit = async (path: string, from: string, to: string) => {
      await v.mem.app.vault.process(v.mem.files.get(path)!, (t: string) => t.replace(from, to));
      await v.manager.analyzeFile(v.mem.files.get(path)! as never, { quiet: true });
      v.manager.rebuildIndexes();
      service.changed(0);
    };
    await edit(RUNBOOK_PATH, "Issue a replacement key", "Issue a new key");
    await edit(POLICY_PATH, "# API Rate Limit Policy\n", "# API Rate Limit Policy\n\nChanged.\n");
    await vi.waitFor(() => expect(stream.seen.filter((s) => s.method === "notifications/resources/updated").map((s) => s.params?.uri)).toEqual([POLICY]));
    expect(stream.methods()).not.toContain("notifications/resources/list_changed");

    // A new concept: the set of resources changed.
    const created = await v.mem.app.vault.create("semantic/new-one.md", note(77));
    await v.manager.analyzeFile(created as never, { quiet: true });
    v.manager.rebuildIndexes();
    service.changed(0);
    await vi.waitFor(() => expect(stream.methods()).toContain("notifications/resources/list_changed"));
    // Nothing changed: nothing is told.
    const count = stream.seen.length;
    service.changed(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.seen.length).toBe(count);

    // The write switch: the tool list and the prompt list both change.
    settings.mcpAllowWrites = true;
    await service.sync();
    await vi.waitFor(() => expect(stream.methods()).toEqual(expect.arrayContaining(["notifications/tools/list_changed", "notifications/prompts/list_changed"])));
    stream.close();
    await service.dispose();
  });
});

describe("a prompt run as a command", () => {
  it("takes words a client split across the recall prompt's filters back into the topic, and keeps a real filter", async () => {
    const c = await connect(await vault());
    const text = async (args: Record<string, string>) => JSON.stringify((await c.client.getPrompt({ name: "mif_vault_recall", arguments: args })).messages);
    // /…recall "rate limits" as Claude Code sends it.
    const split = await text({ topic: '"rate', entity_type: 'limits"' });
    expect(split).toContain("holds about: rate limits\\n");
    // What the server cannot see, the model is told to look for: a client may pass only the first word.
    expect(split).toContain("the client cut it short");
    expect(split).not.toContain("Keep to");
    const three = await text({ topic: "gateway", entity_type: "rate", namespace: "limits" });
    expect(three).toContain("holds about: gateway rate limits");
    // A filter that names something the vault has is still a filter.
    const real = await text({ topic: "keys", entity_type: "how-to-guide", namespace: "_semantic" });
    expect(real).toContain("holds about: keys\\n");
    expect(real).toContain('entity type \\"how-to-guide\\" and namespace \\"_semantic\\"');
    await c.close();
  });
});

describe("curation prompts", () => {
  it("are offered only while the vault allows writes, and name only tools that exist", async () => {
    const off = await connect(await vault());
    expect((await off.client.listPrompts()).prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
    await off.close();
    const c = await connect(await vault({ settings: { mcpAllowWrites: true } }));
    expect((await c.client.listPrompts()).prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES, ...WRITE_PROMPT_NAMES]);
    expect(WRITE_PROMPT_NAMES).toEqual(["mif_vault_capture", "mif_vault_review_stale", "mif_vault_curate_links", "mif_vault_consolidate"]);
    const names = new Set<string>([...TOOL_NAMES, ...WRITE_TOOL_NAMES, ...PROMPT_NAMES, ...WRITE_PROMPT_NAMES]);
    const text = async (name: string, args: Record<string, string>) => JSON.stringify((await c.client.getPrompt({ name, arguments: args })).messages);
    const stale = await text("mif_vault_review_stale", { namespace: "_semantic/policies", limit: "3" });
    expect(stale).toContain("mif_vault_list_concepts");
    expect(stale).toContain("_semantic/policies");
    expect(stale).toContain("limit: 3");
    expect(stale).toMatch(/supersede/);
    const links = await text("mif_vault_curate_links", { entity_type: "how-to-guide" });
    expect(links).toMatch(/report: \\"gaps\\"/);
    expect(links).toContain("how-to-guide");
    expect(links).toContain("mif_vault_write_relationship");
    const consolidate = await text("mif_vault_consolidate", { topic: "rate limiting incidents" });
    expect(consolidate).toContain("rate limiting incidents");
    expect(consolidate).toContain("the client cut it short");
    expect(await text("mif_vault_capture", { what: '"Burst' })).toMatch(/vault \\"test-vault\\": Burst\\n[^"]*the client cut it short/);
    expect(consolidate).toContain("derived-from");
    for (const body of [stale, links, consolidate]) {
      expect(body).toContain("review queue");
      for (const mentioned of body.match(/mif_vault_[a-z_]+/g) ?? []) expect(names.has(mentioned), mentioned).toBe(true);
    }
    await c.close();
  });
});

describe("the gap report as a task", () => {
  const TASKS = "io.modelcontextprotocol/tasks";
  const post = async (port: number, method: string, params: Record<string, unknown>, name: string | undefined, caps: Record<string, unknown>) => {
    const m = modern(method, params, name);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { ...META, "io.modelcontextprotocol/clientCapabilities": caps } } });
    const r = await raw(port, { headers: m.headers, body });
    const data = r.body.startsWith("{") ? r.body : r.body.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
    return JSON.parse(data) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };

  it("gives a client that declares the Tasks extension a task at once, and the report when it polls", async () => {
    const v = await vault();
    const c = await connect(v);
    const port = c.endpoint.port;
    expect((await c.client.discover()).capabilities).toMatchObject({ extensions: { [TASKS]: {} } });
    const args = { name: "mif_vault_get_status", arguments: { report: "gaps" } };
    // A client that does not declare it waits on the request, as before.
    const plain = await post(port, "tools/call", args, "mif_vault_get_status", {});
    expect(plain.result).toMatchObject({ resultType: "complete", structuredContent: { report: "gaps" } });

    const started = await post(port, "tools/call", args, "mif_vault_get_status", { extensions: { [TASKS]: {} } });
    expect(started.result).toMatchObject({ resultType: "task", status: "working", ttlMs: 600_000, pollIntervalMs: 1_000 });
    const taskId = started.result!.taskId as string;
    expect(taskId).toMatch(/^[0-9a-f]{64}$/);
    expect(started.result!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    let got = await post(port, "tasks/get", { taskId }, taskId, {});
    await vi.waitFor(async () => {
      got = await post(port, "tasks/get", { taskId }, taskId, {});
      expect(got.result).toMatchObject({ status: "completed" });
    });
    expect(got.result).toMatchObject({ taskId, resultType: "complete", result: { structuredContent: { report: "gaps", gaps: plain.result!.structuredContent && (plain.result!.structuredContent as { gaps: unknown }).gaps } } });
    // Cancelling a finished task leaves it as it is; an unknown id is an invalid-params error for both methods.
    expect((await post(port, "tasks/cancel", { taskId }, taskId, {})).result).toMatchObject({ resultType: "complete" });
    expect((await post(port, "tasks/get", { taskId }, taskId, {})).result).toMatchObject({ status: "completed" });
    const unknown = "0".repeat(64);
    expect((await post(port, "tasks/get", { taskId: unknown }, unknown, {})).error).toMatchObject({ code: -32602 });
    expect((await post(port, "tasks/cancel", { taskId: unknown }, unknown, {})).error).toMatchObject({ code: -32602 });
    // The other reports, and other tools, never become tasks.
    expect((await post(port, "tools/call", { name: "mif_vault_get_status", arguments: {} }, "mif_vault_get_status", { extensions: { [TASKS]: {} } })).result).toMatchObject({ resultType: "complete" });
    await c.close();
  });

  it("keeps a task for its lifetime only, drops the result of a cancelled one, and declines when too many are working", async () => {
    let now = 1_000_000;
    const store = new TaskStore(60_000, 500, 2, () => now);
    let finish: (v: unknown) => void = () => undefined;
    const slow = store.start((say) => {
      say("Compared 1 of 3 concepts");
      return new Promise((resolve) => (finish = resolve));
    })!;
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(slow.taskId)).toMatchObject({ status: "working", statusMessage: "Compared 1 of 3 concepts", ttlMs: 60_000, pollIntervalMs: 500 });
    expect(store.start(() => new Promise(() => undefined))).toBeDefined();
    expect(store.start(() => Promise.resolve(1))).toBeUndefined();
    expect(store.cancel(slow.taskId)).toBe(true);
    finish({ content: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get(slow.taskId)).toMatchObject({ status: "cancelled" });
    expect(store.get(slow.taskId)).not.toHaveProperty("result");
    const failed = store.start(() => Promise.reject(new Error("mif-cli went away")))!;
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get(failed.taskId)).toMatchObject({ status: "failed", error: { code: -32603, message: "mif-cli went away" } });
    now += 60_001;
    expect(store.get(failed.taskId)).toBeUndefined();
    expect(store.cancel(slow.taskId)).toBe(false);
  });
});

// --- Results are text by default --------------------------------------------------------

describe("the shape of a result", () => {
  it("is text only unless the structured copy is asked for: no structured content, no output schema, and JSON as text on request", async () => {
    const v = await vault({ settings: { mcpAllowWrites: true, duplicateThreshold: 0.9 } });
    const endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1" });
    const client = new Client({ name: "vitest", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Called;
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    for (const t of tools) expect(t.outputSchema, t.name).toBeUndefined();
    // The text is what a model reads: the weighing in words is there, and nothing is sent twice.
    const read = await call("mif_vault_get_concept", { concept: "Old Rate Limit", include_expired: true });
    expect(read.structuredContent).toBeUndefined();
    expect(textOf(read)).toMatch(/EXPIRED/i);
    // A program asks for JSON and parses the text.
    const json = await call("mif_vault_get_status", { response_format: "json" });
    expect(json.structuredContent).toBeUndefined();
    expect(JSON.parse(textOf(json))).toMatchObject({ report: "graph", graph: { concepts: 4, awaiting_review: 1 } });
    // Writes, errors, resource links and tasks keep working without it.
    const wrote = await call("mif_vault_write_concept", { operation: "create", title: "Text Only", type: "semantic", body: "x" });
    expect(wrote.structuredContent).toBeUndefined();
    expect(textOf(wrote)).toContain("Created Text Only [semantic/Text-Only.md]");
    expect(wrote.content.some((c) => c.type === "resource_link")).toBe(true);
    expect((await call("mif_vault_get_concept", { concept: "No Such Thing" })).isError).toBe(true);
    const m = modern("tools/call", { name: "mif_vault_get_status", arguments: { report: "gaps" } }, "mif_vault_get_status");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mif_vault_get_status", arguments: { report: "gaps" }, _meta: { ...META, "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } } } });
    const started = JSON.parse((await raw(endpoint.port, { headers: m.headers, body })).body) as { result: { resultType: string; taskId: string } };
    expect(started.result.resultType).toBe("task");
    await vi.waitFor(async () => {
      const g = modern("tasks/get", { taskId: started.result.taskId }, started.result.taskId);
      const got = JSON.parse((await raw(endpoint.port, g)).body) as { result: { status: string; result?: { content: Array<{ text: string }>; structuredContent?: unknown } } };
      expect(got.result.status).toBe("completed");
      expect(got.result.result!.structuredContent).toBeUndefined();
      expect(got.result.result!.content[0]!.text).toContain("Compared");
    });
    await client.close();
    await endpoint.close();
  });
});
