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
import { CHARACTER_LIMIT, sectionOf, TOOL_NAMES } from "../src/mcp/tools";
import { McpService, VaultMcpHost } from "../src/mcpHost";
import { DEFAULT_SETTINGS, type MifSettings } from "../src/settings";
import { memoryApp } from "./support/obsidian-stub";

const vaultNote = (p: string) => readFileSync(join(__dirname, "../test-vault", p), "utf8");
const POLICY = "urn:mif:7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e";
const INCIDENT = "urn:mif:a1d2c3b4-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const RUNBOOK = "urn:mif:c4b5a6d7-8f90-4123-a456-7b8c9d0e1f23";
const OLD = "urn:mif:0d0d0d0d-1111-4222-8333-444444444444";

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
    cb(null, a[0] === "search" ? searchOutput : "", "");
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
    const rels = r.structuredContent!.relationships as Array<{ type: string; direction: string; concept?: { id: string }; strength?: number; hop: number }>;
    expect(rels.map((e) => [e.direction, e.type, e.concept?.id])).toEqual([
      ["outgoing", "derived-from", INCIDENT],
      ["outgoing", "relates-to", RUNBOOK],
      ["incoming", "relates-to", RUNBOOK],
    ]);
    expect(rels[0]!.strength).toBe(0.9);
    expect(r.structuredContent).toMatchObject({ total_count: 3, count: 3, has_more: false, excluded_expired: 1, types: ["derived-from", "relates-to"] });
    expect(textOf(r)).toContain("include_expired: true");
    const all = await call("mif_vault_list_relationships", { concept: POLICY, include_expired: true });
    expect((all.structuredContent!.relationships as Array<{ concept?: { id: string } }>).map((e) => e.concept?.id)).toContain(OLD);
    const past = await call("mif_vault_list_relationships", { concept: POLICY, as_of: "2026-01-20" });
    expect(past.structuredContent!.excluded_expired).toBe(0);
  });

  it("follows relationships to a depth, filters by type and direction, and pages", async () => {
    const two = await call("mif_vault_list_relationships", { concept: INCIDENT, depth: 2 });
    const rels = two.structuredContent!.relationships as Array<{ hop: number; type: string; from: { id: string }; concept?: { id: string } }>;
    expect(rels.filter((e) => e.hop === 1).map((e) => [e.type, e.concept?.id])).toEqual([["derived-from", POLICY]]);
    expect(rels.filter((e) => e.hop === 2).every((e) => e.from.id === POLICY)).toBe(true);
    expect(rels.filter((e) => e.hop === 2).map((e) => e.concept?.id)).toContain(RUNBOOK);
    const typed = await call("mif_vault_list_relationships", { concept: POLICY, types: ["derived-from"], direction: "outgoing" });
    expect(typed.structuredContent).toMatchObject({ total_count: 1 });
    const paged = await call("mif_vault_list_relationships", { concept: POLICY, limit: 2 });
    expect(paged.structuredContent).toMatchObject({ count: 2, total_count: 3, has_more: true, next_offset: 2 });
    const rest = await call("mif_vault_list_relationships", { concept: POLICY, limit: 2, offset: 2 });
    expect(rest.structuredContent).toMatchObject({ count: 1, has_more: false });
    const none = await call("mif_vault_list_relationships", { concept: INCIDENT, direction: "outgoing" });
    expect(textOf(none)).toContain("no typed relationships");
  });

  it("searches through the plugin's mif-cli bridge and weighs each hit", async () => {
    const r = await call("mif_vault_search_concepts", { query: "rate limits", entity_type: "how-to-guide", folder: "semantic" });
    const search = calls.find((a) => a[0] === "search")!;
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
