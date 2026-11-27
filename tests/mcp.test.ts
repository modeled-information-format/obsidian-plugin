// The MCP server (Phase 0 of docs/PLAN-mcp.md): the real endpoint on a
// loopback port, over a MifManager on the in-memory vault and a fake mif-cli,
// driven by the SDK's own client and by raw HTTP for what a client would
// never send.

import { readFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MifCli } from "../src/cliBridge";
import { MifManager } from "../src/manager";
import { MAX_BODY, newToken, refusal, sameToken, startEndpoint, type McpEndpoint } from "../src/mcp/http";
import { guide, PROMPT_NAMES, RESOURCE_TEMPLATE } from "../src/mcp/extras";
import { CHARACTER_LIMIT, countEdges, countsLine, sectionOf, TOOL_NAMES } from "../src/mcp/tools";
import { McpService, VaultMcpHost } from "../src/mcpHost";
import { DEFAULT_SETTINGS, type MifSettings } from "../src/settings";
import { memoryApp } from "./support/obsidian-stub";

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
relationships:
  - type: relates-to
    target: /semantic/rate-limit-policy.md
---
# Old Rate Limit

The limit was 50 requests per minute.

## Relationships

- relates-to [API Rate Limit Policy](/semantic/rate-limit-policy.md)
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

async function vault(opts: { store?: boolean } = {}) {
  const v = memoryApp({
    "semantic/rate-limit-policy.md": vaultNote("semantic/rate-limit-policy.md"),
    "episodic/incident-2026-01-rate-spike.md": vaultNote("episodic/incident-2026-01-rate-spike.md"),
    "procedural/rotate-api-keys.md": vaultNote("procedural/rotate-api-keys.md"),
    "semantic/old-limit.md": OLD_LIMIT,
    "plain.md": "Just a note.\n",
  });
  const hasStore = opts.store ?? true;
  Object.assign(v.app.vault.adapter, {
    exists: async (p: string) => (hasStore && p === ".mif/vectors.db") || p === ".mif",
    read: async () => "",
    write: async () => {},
    mkdir: async () => {},
  });
  const settings: MifSettings = { ...DEFAULT_SETTINGS, mifCliPath: "/bin/mif-cli", mcpPurpose: "Gateway operations memory" };
  const manager = new MifManager(v.app as never, () => settings);
  await manager.loadBundles();
  await manager.scanAll();
  manager.rebuildIndexes();
  const calls: string[][] = [];
  const exec = (_file: string, args: string[], _o: unknown, cb: (e: (Error & { code?: number }) | null, out: string, err: string) => void) => {
    const a = args.slice(2);
    if (a[0] === "--version") return cb(null, "mif-cli 0.13.0\n", "");
    calls.push(a);
    const out: Record<string, string> = {
      search: searchOutput,
      // Every concept's neighbours, nearest first; a concept's own row is ignored by the callers.
      "find-similar": `0.8000  ${RUNBOOK}\n0.4000  ${INCIDENT}\n`,
      "corpus-stats": "count=3 dim=384 db=/v/.mif/vectors.db passages=9 documents_without_passages=0 documents_without_text=0\n",
      prune: "would prune 0 documents, 4 found under /v (db=/v/.mif/vectors.db)\n",
    };
    cb(null, out[a[0]!] ?? "", "");
  };
  const cli = new MifCli(v.app as never, manager, () => settings, exec as never, () => ({ path: "", home: "/h", windows: false, isExecutable: () => false }));
  return { host: new VaultMcpHost(v.app as never, manager, cli, () => settings), settings, calls };
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
    endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1" });
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
    // Counts are not filtered by freshness: the expired note's relationship is counted, though the listing leaves it out.
    expect(policy.structuredContent!.concepts).toEqual([
      { concept: { id: POLICY, path: POLICY_PATH, bundle: "", title: "API Rate Limit Policy", type: "semantic" }, relationship_counts: { outgoing: { "derived-from": 1, "relates-to": 1 }, incoming: { "relates-to": 2 } } },
    ]);
    expect(policy.structuredContent).toMatchObject({ count: 0, relationships: [] });
    // A filter that matches nothing still says what the concept has.
    const none = await call("mif_vault_list_relationships", { concept: INCIDENT, types: ["supersedes"] });
    expect(textOf(none)).toContain("its counts show what it does have");
    expect(textOf(none)).toContain("incoming): derived-from 1");
  });

  it("lists relationships compactly by default and in full on request", async () => {
    const compact = await call("mif_vault_list_relationships", { concept: POLICY, include_expired: true });
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
    const full = await call("mif_vault_list_relationships", { concept: POLICY, detail: "full" });
    expect(textOf(full)).toContain(`Rate Spike Incident 2026-01 (${INCIDENT}, episodic/incident-2026-01-rate-spike.md) — timeless, trust not recorded`);
    expect((full.structuredContent!.relationships as Array<{ weighing?: unknown; id?: string }>).every((r) => r.weighing && r.id)).toBe(true);
    expect(text.length).toBeLessThan(textOf(full).length);
  });

  it("answers for several concepts in one call, and says what they share or do not", async () => {
    const each = await call("mif_vault_list_relationships", { concept: [INCIDENT, "Rotate API Keys"] });
    expect((each.structuredContent!.concepts as Array<{ concept: { id: string } }>).map((c) => c.concept.id)).toEqual([INCIDENT, RUNBOOK]);
    expect(each.structuredContent).toMatchObject({ combine: "each", total_count: 3 });
    expect(textOf(each)).toContain("Rate Spike Incident 2026-01 [episodic/incident-2026-01-rate-spike.md]: 1 relationship(s).");
    expect(textOf(each)).toContain("Rotate API Keys [procedural/rotate-api-keys.md]: 2 relationship(s).");
    const shared = await call("mif_vault_list_relationships", { concept: [INCIDENT, RUNBOOK], combine: "intersect" });
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
    const r = await call("mif_vault_list_relationships", { concept: INCIDENT, path: [{ type: "derived-from", direction: "incoming" }, { type: "relates-to" }] });
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
    const r = await call("mif_vault_list_relationships", { concept: POLICY, direction: "outgoing", neighbor_counts: true });
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
    const many = await call("mif_vault_list_concepts", { relationship: { type: "relates-to", direction: "incoming", min: 2 } });
    expect(many.structuredContent!.concepts).toMatchObject([{ path: POLICY_PATH, relationships: 2 }]);
    expect(textOf(many)).toContain("  - API Rate Limit Policy — 2");
    const none = await call("mif_vault_list_concepts", { relationship: { direction: "outgoing", min: 0, max: 0 } });
    expect((none.structuredContent!.concepts as Array<{ path: string }>).map((c) => c.path)).toEqual([INCIDENT_PATH]);
    const ranked = await call("mif_vault_list_concepts", { relationship: { min: 0 }, sort: "relationships", limit: 1 });
    expect(ranked.structuredContent).toMatchObject({ concepts: [{ path: POLICY_PATH, relationships: 4 }], has_more: true, next_offset: 1 });
    const grouped = await call("mif_vault_list_concepts", { group_by: "type", include_expired: true });
    expect(grouped.structuredContent).toMatchObject({ total_count: 4, groups: { semantic: 2, episodic: 1, procedural: 1 }, concepts: [] });
    expect((await call("mif_vault_list_concepts", { entity_type: "nothing" })).structuredContent).toMatchObject({ total_count: 0 });
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
    const r = await call("mif_vault_list_relationships", { concept: INCIDENT, path_to: "Rotate API Keys" });
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
      by_entity_type: { "(none)": 4 },
      relationships: 4,
      by_relationship_type: { "relates-to": 3, "derived-from": 1 },
      unresolved_targets: 0,
      without_relationships: 0,
      freshness: { timeless: 3, expired: 1 },
      trust: { "(none)": 3, uncertain: 1 },
      entities: 1,
    });
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

  it("links a concept it returns to its resource, once", async () => {
    const r = (await client.callTool({ name: "mif_vault_get_concept", arguments: { concept: POLICY, include_body: false } })) as { content: Array<{ type: string; uri?: string; name?: string }> };
    expect(r.content.filter((c) => c.type === "resource_link")).toEqual([{ type: "resource_link", uri: POLICY, name: "API Rate Limit Policy", mimeType: "text/markdown" }]);
    const listed = (await client.callTool({ name: "mif_vault_list_relationships", arguments: { concept: POLICY } })) as { content: Array<{ type: string }> };
    expect(listed.content.every((c) => c.type === "text")).toBe(true);
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

describe("search without a vector store", () => {
  it("says search is unavailable and what to use instead", async () => {
    const v = await vault({ store: false });
    const endpoint = await startEndpoint(http, { host: v.host, port: 0, token: () => TOKEN, version: "0.0.1" });
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
    const service = new McpService(v.host, () => settings, () => http, "0.0.1");
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
    const mobile = new McpService(v.host, () => ({ ...settings, mcpEnabled: true, mcpPort: 27182 }), () => undefined, "0.0.1");
    expect(await mobile.sync()).toMatchObject({ state: "failed", reason: "The MCP server is desktop only." });
    await service.dispose();
  });
});
