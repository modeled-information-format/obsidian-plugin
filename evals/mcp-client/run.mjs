// Evaluate the MCP server through a real client: Claude Code, run headless.
//
// Unit tests call the server with the SDK's client and well-formed arguments;
// they cannot see what a real client does before a request is made (how it
// splits a prompt's arguments, what capabilities it declares, whether it reads
// a resource or calls a tool, what it shows the model). Each case here is one
// Claude Code session behind a recording proxy, checked against what crossed
// the proxy, what Claude Code answered, and what is in the vault afterwards.
//
//   node evals/mcp-client/run.mjs [--only <id,id>] [--area <name,name>] [--mode writes-on|writes-off]
//                                 [--jobs <n>] [--repeat <n>] [--keep] [--dump] [--dry]
//
// Needs: the plugin's test vault open in Obsidian with the MCP server on;
// `claude` on PATH and signed in. With writes on (the default mode) it also
// needs "Allow MCP writes" on and no uncommitted changes under test-vault/,
// because the write cases change notes there and undo them from git.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cases, SERVER } from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const vault = join(repo, "test-vault");
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const only = flag("--only")?.split(",");
const areas = flag("--area")?.split(",");
const mode = flag("--mode") ?? "writes-on";
const jobs = Number(flag("--jobs") ?? 4);
const repeatAll = flag("--repeat") === undefined ? undefined : Number(flag("--repeat"));
const keep = process.argv.includes("--keep");
const dump = process.argv.includes("--dump");
// --dry: no Claude Code. The directed cases' calls are sent straight to the server, to check the
// cases themselves before spending sessions on them. It says nothing about the client.
const dry = process.argv.includes("--dry");

const settings = JSON.parse(readFileSync(join(vault, ".obsidian/plugins/mif/data.json"), "utf8"));
const target = { host: "127.0.0.1", port: settings.mcpPort };
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });

// A case belongs to one mode; most are for a vault with writes on.
const selected = cases.filter((c) => (c.mode ?? "writes-on") === mode && (!only || only.includes(c.id)) && (!areas || areas.includes(c.area)) && (!process.argv.includes("--dry") || c.directed));
if (!selected.length) throw new Error("No case matches.");
const writing = selected.some((c) => c.writes);

// --- talking to the server directly, for what the runner itself needs to know ------------

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "mif-eval-runner", version: "1" } };
async function direct(method, params = {}, name, meta = META) {
  const r = await fetch(`http://${target.host}:${target.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${settings.mcpToken}`, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
  const text = await r.text();
  const body = JSON.parse(text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5));
  if (body.error && !meta.raw) throw new Error(`${method}: ${body.error.message}`);
  return meta.raw ? body : body.result;
}

/** A directed case without a client: its call, and a declined answer if the server asks the user. */
async function drySession(c) {
  const meta = { ...META, "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }, "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "dry" } };
  const traffic = [];
  const send = async (extra = {}) => {
    const params = { name: c.directed.tool, arguments: c.directed.args, ...extra };
    const body = await direct("tools/call", params, c.directed.tool, { ...meta, raw: true });
    traffic.push({ method: "tools/call", params: { ...params, _meta: meta }, status: 200, result: body.result, error: body.error });
    return body.result;
  };
  const first = await send();
  if (first?.resultType === "input_required") await send({ inputResponses: Object.fromEntries(Object.keys(first.inputRequests ?? {}).map((k) => [k, { action: "decline" }])) });
  return { text: "DONE", cost: 0, traffic, seconds: 0, input: "" };
}

let served;
try {
  served = (await direct("tools/list")).tools.map((t) => t.name);
} catch (e) {
  throw new Error(`The test vault's MCP server is not answering on port ${target.port}: ${e.message}. Open the test vault in Obsidian with the server on.`);
}
const writesOn = served.includes("mif_vault_write_concept");
if (mode === "writes-on" && !writesOn) throw new Error('Mode writes-on needs "Allow MCP writes" on in the test vault.');
if (mode === "writes-off" && writesOn) throw new Error('Mode writes-off needs "Allow MCP writes" off in the test vault.');
// The write cases make more writes than the default limit allows in its window (30 in 10 minutes).
if (writing && !dry && (settings.mcpWriteLimit ?? 30) < 200) throw new Error('The write cases need "MCP write limit" raised to 200 or more in the test vault for the run.');
if (writing && git("status", "--porcelain", "--", "test-vault").trim()) throw new Error("test-vault has uncommitted changes; the write cases would mix with them. Commit or stash first, or run only read cases.");

// What the cases need to know about this vault before they can be written out.
const resources = (await direct("resources/list")).resources;
const world = {
  ontologyUri: resources.find((r) => /ontology/i.test(`${r.description ?? ""} ${r.name ?? ""}`) && !r.uri.startsWith("urn:mif:entity:"))?.uri,
  resourceCount: resources.length,
  tools: served,
};

// --- the recording proxy: one per Claude Code session -------------------------------------

const parseBody = (text) => {
  try {
    if (text.trimStart().startsWith("{")) return JSON.parse(text);
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    // A stream: the last message with a result or an error is the response.
    return data.map((d) => JSON.parse(d)).reverse().find((m) => m.result !== undefined || m.error !== undefined);
  } catch {
    return undefined;
  }
};

async function startProxy() {
  /** Every JSON-RPC request the client sent, with what came back. */
  const traffic = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        message = undefined;
      }
      const entry = { at: Date.now(), httpMethod: req.method, method: message?.method, params: message?.params, protocolHeader: req.headers["mcp-protocol-version"] };
      traffic.push(entry);
      const out = http.request({ ...target, method: req.method, path: req.url, headers: { ...req.headers, host: `${target.host}:${target.port}` } }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        let text = "";
        up.on("data", (c) => {
          if (text.length < 4_000_000) text += c.toString("utf8");
          res.write(c);
        });
        up.on("end", () => {
          entry.status = up.statusCode;
          const parsed = parseBody(text);
          entry.result = parsed?.result;
          entry.error = parsed?.error;
          res.end();
        });
      });
      out.on("error", (e) => {
        entry.status = 502;
        entry.error = { message: e.message };
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      // A client that goes away ends its request: stop the upstream one too.
      res.on("close", () => (res.writableEnded ? undefined : out.destroy()));
      out.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    traffic,
    port: server.address().port,
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

// --- one Claude Code session ---------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "mif-mcp-eval-"));
let sessions = 0;

async function session(c) {
  const proxy = await startProxy();
  const config = join(work, `mcp-${++sessions}.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: `http://127.0.0.1:${proxy.port}/mcp`, headers: { Authorization: `Bearer ${settings.mcpToken}` } } } }));
  const input = typeof c.input === "function" ? c.input(world) : c.input;
  const args = ["-p", input, "--model", c.model ?? (c.directed ? "haiku" : "sonnet"), "--output-format", "json", "--mcp-config", config, "--strict-mcp-config"];
  // Without an allow rule a headless session cannot use an MCP tool at all, which is what a
  // case about what the client sends wants: it is not about what the model then does.
  if (c.tools !== false) args.push("--allowedTools", `mcp__${SERVER}`);
  const started = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", () => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = undefined;
      }
      resolve({ text: parsed?.result ?? "", cost: parsed?.total_cost_usd ?? 0, raw: parsed ? undefined : (out + err).slice(0, 600) });
    });
  });
  proxy.close();
  return { ...run, input, traffic: proxy.traffic, seconds: Math.round((Date.now() - started) / 1000) };
}

// --- what a case sees ------------------------------------------------------------------------

const resultText = (t) => (t.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const note = (path) => (existsSync(join(vault, path)) ? readFileSync(join(vault, path), "utf8") : undefined);
const capsOf = (t) => t?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
const view = (slice) => ({
  all: slice,
  text: resultText,
  capsOf,
  of: (method, name) => slice.filter((t) => t.method === method && (name === undefined || t.params?.name === name)),
  tools: () => slice.filter((t) => t.method === "tools/call").map((t) => t.params?.name),
  prompt: (name) => {
    const t = slice.find((x) => x.method === "prompts/get" && x.params?.name === name);
    return t ? { args: t.params?.arguments ?? {}, text: (t.result?.messages ?? []).map((m) => m.content?.text ?? "").join("\n") } : undefined;
  },
  capabilities: () => slice.map(capsOf).find(Boolean),
  clientInfo: () => slice.map((t) => t.params?._meta?.["io.modelcontextprotocol/clientInfo"]).find(Boolean),
  protocol: () => slice.map((t) => t.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? t.protocolHeader).find(Boolean),
});

function judge(c, run) {
  const checks = [];
  const facts = {};
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: typeof detail === "string" ? detail.slice(0, 500) : detail === undefined ? undefined : JSON.stringify(detail).slice(0, 500) }) });
  try {
    c.verify({ answer: run.text, traffic: view(run.traffic), note, check, fact: (k, v) => (facts[k] = v), world });
  } catch (e) {
    check("verify ran", false, e.message);
  }
  if (run.raw) check("claude ran", false, run.raw);
  return { ok: checks.length > 0 && checks.every((x) => x.ok), checks, facts };
}

const allTraffic = [];
async function runCase(c) {
  const times = repeatAll ?? c.repeat ?? 1;
  const attempts = [];
  for (let i = 0; i < times; i++) {
    let run = dry ? await drySession(c) : await session(c);
    let verdict = judge(c, run);
    // A directed case is about the server, not about whether the model did as told: if it made a
    // different call, ask once more. The retry is recorded, never hidden.
    let retried = false;
    if (!dry && c.directed && !verdict.ok && verdict.checks[0]?.name === "called as directed" && !verdict.checks[0].ok) {
      retried = true;
      run = await session(c);
      verdict = judge(c, run);
    }
    if (dump) allTraffic.push({ id: c.id, attempt: i + 1, traffic: run.traffic });
    attempts.push({ ...verdict, retried, cost: run.cost, seconds: run.seconds, answer: run.text.slice(0, 500), methods: run.traffic.map((t) => (t.method === "tools/call" || t.method === "prompts/get" ? `${t.method} ${t.params?.name}` : t.method)).filter(Boolean) });
  }
  const passes = attempts.filter((a) => a.ok).length;
  // Where the model decides, one run proves little: such a case runs several times and must pass in most.
  const need = c.need ?? (times === 1 ? 1 : Math.floor(times / 2) + 1);
  // A known gap is a case that fails for a reason outside the server, written down in the case. It is
  // reported as a gap, never as a pass, and it is reported loudly if it starts passing.
  const result = { ...(c.knownGap ? { knownGap: c.knownGap } : {}), id: c.id, area: c.area, kind: c.directed ? "directed" : c.tools === false ? "client" : "agent", what: c.what, input: typeof c.input === "function" ? c.input(world) : c.input, ok: passes >= need, passes, times, need, attempts };
  const first = attempts.find((a) => !a.ok) ?? attempts[0];
  console.log(`${result.ok ? (c.knownGap ? "PASS (a known gap has closed)" : "PASS") : c.knownGap ? "GAP " : "FAIL"}  ${c.id.padEnd(28)} ${times > 1 ? `${passes}/${times}  ` : ""}${c.what}${attempts.some((a) => a.retried) ? "  (retried)" : ""}`);
  for (const x of first.checks.filter((x) => !x.ok)) console.log(`        ✗ ${x.name}${x.detail ? `: ${String(x.detail).replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
  for (const [k, v] of Object.entries(first.facts)) console.log(`        · ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return result;
}

// --- run: setup cases first, then those that only read (several at once), then the writers ---

const results = [];
const stage = (name) => selected.filter((c) => (c.stage ?? (c.writes ? "write" : "read")) === name);
for (const c of stage("setup")) results.push(await runCase(c));
{
  const queue = [...stage("read")];
  await Promise.all(
    Array.from({ length: Math.max(1, jobs) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) results.push(await runCase(c));
    }),
  );
}
for (const c of stage("write")) results.push(await runCase(c));
results.sort((a, b) => selected.findIndex((c) => c.id === a.id) - selected.findIndex((c) => c.id === b.id));

// --- undo what the write cases changed -------------------------------------------------------

if (!keep && writing) {
  for (const line of git("status", "--porcelain", "--", "test-vault").split("\n").filter(Boolean)) {
    const path = line.slice(3).replace(/^"|"$/g, "");
    // Only notes: whatever else is in the vault folder is not this run's to touch.
    if (!path.endsWith(".md")) continue;
    if (line.startsWith("??")) rmSync(join(repo, path));
    else git("checkout", "--", path);
  }
  // Entity records live under .mif, which git does not track: remove the ones the cases record.
  const people = join(vault, ".mif/entities/person");
  if (existsSync(people)) for (const f of readdirSync(people)) if (f.startsWith("eval-probe-")) rmSync(join(people, f));
}
rmSync(work, { recursive: true, force: true });

// --- report ----------------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const gaps = results.filter((r) => !r.ok && r.knownGap);
const failed = results.filter((r) => !r.ok && !r.knownGap);
const cost = results.reduce((n, r) => n + r.attempts.reduce((m, a) => m + a.cost, 0), 0);
const client = results.flatMap((r) => r.attempts.map((a) => a.facts["client name"])).find(Boolean);
mkdirSync(join(here, "results"), { recursive: true });
const stamp = { at: new Date().toISOString(), mode, client, passed, gaps: gaps.length, failed: failed.length, total: results.length, cost };
const label = dry ? `${mode}-dry` : mode;
writeFileSync(join(here, `results/latest-${label}.json`), JSON.stringify({ ...stamp, results }, null, 2) + "\n");
if (dump) writeFileSync(join(here, "results/traffic.json"), JSON.stringify(allTraffic, null, 2) + "\n");
const byArea = [...new Set(results.map((r) => r.area))];
const md = [
  `# MCP client evals: ${label}`,
  "",
  `${stamp.at} · ${client ?? "client unknown"} · ${passed} passed, ${failed.length} failed, ${gaps.length} known gap(s), of ${results.length} · $${cost.toFixed(2)}`,
  "",
  "| Area | Cases | Passed |",
  "|---|---|---|",
  ...byArea.map((a) => `| ${a} | ${results.filter((r) => r.area === a).length} | ${results.filter((r) => r.area === a && r.ok).length} |`),
  "",
  "| Case | Kind | Result | What it shows |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.ok ? "pass" : r.knownGap ? "known gap" : "**fail**"}${r.times > 1 ? ` ${r.passes}/${r.times}` : ""}${r.attempts.some((a) => a.retried) ? " (retried)" : ""} | ${r.what} |`),
  "",
  ...gaps.flatMap((r) => [`## Known gap: ${r.id}`, "", r.knownGap, ""]),
  ...failed.flatMap((r) => [`## ${r.id}`, "", ...(r.attempts.find((a) => !a.ok)?.checks.filter((x) => !x.ok).map((x) => `- ${x.name}${x.detail ? `: ${String(x.detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`) ?? []), ""]),
].join("\n");
writeFileSync(join(here, `results/latest-${label}.md`), md + "\n");
console.log(`\n${passed} passed, ${failed.length} failed, ${gaps.length} known gap(s), of ${results.length} · ${mode} · $${cost.toFixed(2)} · evals/mcp-client/results/latest-${label}.md${keep ? " · vault changes kept" : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
