// Evaluate the MCP server through a real client: Claude Code, run headless.
//
// Unit tests call the server with the SDK's client and well-formed arguments;
// they cannot see what a real client does before a request is made (how it
// splits a prompt's arguments, what capabilities it declares, whether it reads
// a resource or calls a tool, what it shows the model). Each case here is one
// Claude Code session behind a recording proxy, checked against what crossed
// the proxy, what Claude Code answered, and what is in the vault afterwards.
//
//   node evals/mcp-client/run.mjs [--server memory|live] [--mode <name>|all]
//        [--only <id,id>] [--area <name,name>] [--jobs <n>] [--repeat <n>]
//        [--agent-model <alias>] [--keep] [--dump] [--dry]
//        [--cases <file>] [--vault <dir>] [--obsidian-vault <name>]
//
// --server memory (the default) starts the real server over an in-memory copy
// of the test vault: no Obsidian, a clean vault for every mode, and settings
// the runner can change. It has no mif-cli, so cases that need the vector
// store are left to --server live, which talks to the test vault open in
// Obsidian. See README.md.

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const has = (name) => process.argv.includes(name);
const server = flag("--server") ?? "memory";
const only = flag("--only")?.split(",");
const areas = flag("--area")?.split(",");
const jobs = Number(flag("--jobs") ?? 4);
const repeatAll = flag("--repeat") === undefined ? undefined : Number(flag("--repeat"));
const agentModel = flag("--agent-model");
const keep = has("--keep");
const dump = has("--dump");
// --dry: no Claude Code. The directed cases' calls are sent straight to the server, to check the
// cases themselves before spending sessions on them. It says nothing about the client.
const dry = has("--dry");
const vaultDir = resolve(flag("--vault") ?? join(repo, "test-vault"));
const obsidianVault = flag("--obsidian-vault") ?? "test-vault";

const { cases, SERVER } = await import(pathToFileURL(resolve(flag("--cases") ?? join(here, "cases.mjs"))).href);

/** The plugin settings each mode stands for. A live vault must already be set this way; an in-memory one is started so. */
const MODES = {
  "writes-on": { mcpAllowWrites: true, mcpWriteLimit: 500 },
  "writes-off": { mcpAllowWrites: false },
  limit: { mcpAllowWrites: true, mcpWriteLimit: 3, mcpWriteWindowMinutes: 10 },
  bundles: { mcpAllowWrites: true, mcpWriteLimit: 500, bundleRoots: ["", "_fixtures/rel"] },
};
const wanted = flag("--mode") ?? (server === "memory" ? "all" : "writes-on");
const modes = wanted === "all" ? Object.keys(MODES) : wanted.split(",");
for (const m of modes) if (!MODES[m]) throw new Error(`No mode "${m}". Modes: ${Object.keys(MODES).join(", ")}, all.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });

// --- the two servers a run can talk to ------------------------------------------------------

/** The test vault open in Obsidian. Its settings are whatever the user set; the runner checks, it cannot change them. */
function liveBackend(mode) {
  const settings = JSON.parse(readFileSync(join(vaultDir, ".obsidian/plugins/mif/data.json"), "utf8"));
  const tracked = vaultDir.startsWith(repo);
  const open = (path) => new Promise((done) => execFile("open", [`obsidian://open?vault=${encodeURIComponent(obsidianVault)}&file=${encodeURIComponent(path)}`], () => done()));
  return {
    name: "live",
    target: { host: "127.0.0.1", port: settings.mcpPort },
    token: settings.mcpToken,
    note: (path) => (existsSync(join(vaultDir, path)) ? readFileSync(join(vaultDir, path), "utf8") : undefined),
    check(selected) {
      const writing = selected.some((c) => c.writes);
      if (writing && !dry && mode === "writes-on" && (settings.mcpWriteLimit ?? 30) < 200) throw new Error('The write cases need "MCP write limit" raised to 200 or more in the test vault for the run.');
      if (writing && tracked && git("status", "--porcelain", "--", "test-vault").trim()) throw new Error("test-vault has uncommitted changes; the write cases would mix with them. Commit or stash first, or run only read cases.");
    },
    ctl: {
      // An edit made outside Obsidian: it sees the file change and the plugin analyses it.
      async edit(path, change) {
        writeFileSync(join(vaultDir, path), change(readFileSync(join(vaultDir, path), "utf8")));
        await sleep(1500);
      },
      async create(path, text) {
        writeFileSync(join(vaultDir, path), text);
        await sleep(1500);
      },
      // Opening a note makes it the active editor, which is enough for the plugin to leave it alone.
      async openEditor(path) {
        await open(path);
        await sleep(2500);
      },
      async closeEditors() {
        await open("index.md");
        await sleep(1500);
      },
      async set() {
        throw new Error("A live vault's settings cannot be changed by the runner; this case is for --server memory.");
      },
    },
    finish(selected) {
      if (keep || !tracked || !selected.some((c) => c.writes)) return;
      for (const line of git("status", "--porcelain", "--", "test-vault").split("\n").filter(Boolean)) {
        const path = line.slice(3).replace(/^"|"$/g, "");
        // Only notes: whatever else is in the vault folder is not this run's to touch.
        if (!path.endsWith(".md")) continue;
        if (line.startsWith("??")) rmSync(join(repo, path));
        else git("checkout", "--", path);
      }
      // Entity records live under .mif, which git does not track: remove the ones the cases record.
      const people = join(vaultDir, ".mif/entities/person");
      if (existsSync(people)) for (const f of readdirSync(people)) if (f.startsWith("eval-probe-")) rmSync(join(people, f));
    },
  };
}

/** The real server over an in-memory copy of the test vault, started fresh with the mode's settings. */
async function memoryBackend(mode) {
  const { startMemory } = await import("./memory.mjs");
  const vault = await startMemory(MODES[mode]);
  return {
    name: "memory",
    target: { host: "127.0.0.1", port: vault.port },
    token: vault.token,
    note: (path) => vault.read(path),
    check() {},
    ctl: {
      edit: (path, change) => vault.edit(path, change),
      create: (path, text) => vault.create(path, text),
      openEditor: async (path, unsaved) => vault.openEditor(path, unsaved, unsaved === undefined),
      closeEditors: async () => vault.closeEditors(),
      set: (patch) => vault.set(patch),
    },
    vault,
    async finish() {
      await vault.close();
    },
  };
}

// --- one mode, start to finish ---------------------------------------------------------------

async function runMode(mode) {
  const backend = server === "memory" ? await memoryBackend(mode) : liveBackend(mode);
  const { target } = backend;
  const selected = cases.filter(
    (c) =>
      (c.mode ?? "writes-on") === mode &&
      (!c.server || c.server === server) &&
      // The in-memory server has no mif-cli: what needs the vector store is evaluated live.
      !(server === "memory" && c.needs === "store") &&
      (!only || only.includes(c.id)) &&
      (!areas || areas.includes(c.area)) &&
      (!dry || c.directed),
  );
  if (!selected.length) {
    await backend.finish(selected);
    return [];
  }

  // --- talking to the server directly, for what the runner itself needs to know ------------
  const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "mif-eval-runner", version: "1" } };
  async function direct(method, params = {}, name, meta = META) {
    const { raw, ...sent } = meta;
    const r = await fetch(`http://${target.host}:${target.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${backend.token}`, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: sent } }),
    });
    const text = await r.text();
    const body = JSON.parse(text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5));
    if (body.error && !raw) throw new Error(`${method}: ${body.error.message}`);
    return raw ? body : body.result;
  }

  let served;
  try {
    served = (await direct("tools/list")).tools.map((t) => t.name);
  } catch (e) {
    throw new Error(`The vault's MCP server is not answering on port ${target.port}: ${e.message}. Open the test vault in Obsidian with the server on, or use --server memory.`);
  }
  const writesOn = served.includes("mif_vault_write_concept");
  if (MODES[mode].mcpAllowWrites !== writesOn) throw new Error(`Mode ${mode} needs "Allow MCP writes" ${MODES[mode].mcpAllowWrites ? "on" : "off"} in the vault.`);
  backend.check(selected);

  // What the cases need to know about this vault before they can be written out.
  const resources = (await direct("resources/list")).resources;
  const world = { ontologyUri: resources.find((r) => r.uri.startsWith("urn:mif:ontology:"))?.uri, resourceCount: resources.length, tools: served, server, mode };

  // --- the recording proxy: one per Claude Code session -------------------------------------
  async function startProxy() {
    /** Every JSON-RPC request the client sent, with what came back. */
    const traffic = [];
    const proxy = http.createServer((req, res) => {
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
        const entry = { at: Date.now(), httpMethod: req.method, method: message?.method, params: message?.params, protocolHeader: req.headers["mcp-protocol-version"], events: [] };
        traffic.push(entry);
        const out = http.request({ ...target, method: req.method, path: req.url, headers: { ...req.headers, host: `${target.host}:${target.port}` } }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          entry.status = up.statusCode;
          entry.open = true;
          const stream = String(up.headers["content-type"] ?? "").includes("text/event-stream");
          let text = "";
          const take = (payload) => {
            let m;
            try {
              m = JSON.parse(payload);
            } catch {
              return;
            }
            // On a stream, what is not the answer is a notification: keep each, with when it arrived.
            if (m.result !== undefined || m.error !== undefined) {
              entry.result = m.result;
              entry.error = m.error;
            } else if (m.method) entry.events.push({ at: Date.now(), method: m.method, params: m.params });
          };
          up.on("data", (c) => {
            res.write(c);
            if (text.length > 4_000_000) return;
            text += c.toString("utf8");
            if (!stream) return;
            for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
              const data = text.slice(0, end).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
              text = text.slice(end + 2);
              if (data) take(data);
            }
          });
          up.on("end", () => {
            if (!stream && text.trim()) take(text);
            entry.open = false;
            res.end();
          });
        });
        out.on("error", (e) => {
          entry.status ??= 502;
          entry.error ??= { message: e.message };
          entry.open = false;
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        // A client that goes away ends its request: stop the upstream one too.
        res.on("close", () => (res.writableEnded ? undefined : out.destroy()));
        out.end(body);
      });
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    return {
      traffic,
      port: proxy.address().port,
      close() {
        proxy.close();
        proxy.closeAllConnections?.();
      },
    };
  }

  // --- one Claude Code session ---------------------------------------------------------------
  const work = mkdtempSync(join(tmpdir(), "mif-mcp-eval-"));
  let sessions = 0;

  async function session(c) {
    const proxy = await startProxy();
    const n = ++sessions;
    const config = join(work, `mcp-${n}.json`);
    writeFileSync(config, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: `http://127.0.0.1:${proxy.port}/mcp`, headers: { Authorization: `Bearer ${backend.token}` } } } }));
    const input = typeof c.input === "function" ? c.input(world) : c.input;
    const kind = c.directed ? "directed" : c.tools === false ? "client" : "agent";
    const args = ["-p", input, "--model", c.model ?? (kind === "agent" && agentModel ? agentModel : kind === "directed" ? "haiku" : "sonnet"), "--output-format", "json", "--mcp-config", config, "--strict-mcp-config"];
    // Without an allow rule a headless session cannot use an MCP tool at all, which is what a
    // case about what the client sends wants: it is not about what the model then does.
    if (c.tools !== false) args.push("--allowedTools", `mcp__${SERVER}`);
    // A case that says how the user answers a question gives Claude Code a hook that answers it so.
    const asked = join(work, `asked-${n}.jsonl`);
    const env = { ...process.env };
    if (c.answer !== undefined) {
      args.push("--settings", JSON.stringify({ hooks: { Elicitation: [{ matcher: SERVER, hooks: [{ type: "command", command: `node ${JSON.stringify(join(here, "answer.mjs"))}` }] }] } }));
      env.MIF_EVAL_ANSWER = JSON.stringify(c.answer);
      env.MIF_EVAL_ASKED = asked;
    }
    const started = Date.now();
    await c.before?.(backend.ctl);
    const done = new Promise((resolveRun) => {
      const child = spawn("claude", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"], env });
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
        resolveRun({ text: parsed?.result ?? "", cost: parsed?.total_cost_usd ?? 0, raw: parsed ? undefined : (out + err).slice(0, 600) });
      });
    });
    // Something that must happen while the client is connected: once its change subscription is open.
    let during;
    if (c.during) {
      for (let i = 0; i < 300 && !proxy.traffic.some((t) => t.method === "subscriptions/listen" && t.open); i++) await sleep(100);
      await sleep(400);
      during = await c.during(backend.ctl).then(
        () => "done",
        (e) => `failed: ${e.message}`,
      );
    }
    const run = await done;
    // Let a notification already on its way reach the proxy before the stream is cut.
    if (c.during) await sleep(300);
    await c.after?.(backend.ctl);
    proxy.close();
    const elicitations = existsSync(asked) ? readFileSync(asked, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...run, input, during, elicitations, traffic: proxy.traffic, seconds: Math.round((Date.now() - started) / 1000) };
  }

  /** A directed case without a client: its call, and a declined answer if the server asks the user. */
  async function drySession(c) {
    const meta = { ...META, "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }, "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "dry" } };
    const traffic = [];
    await c.before?.(backend.ctl);
    const send = async (extra = {}) => {
      const params = { name: c.directed.tool, arguments: c.directed.args, ...extra };
      const body = await direct("tools/call", params, c.directed.tool, { ...meta, raw: true });
      traffic.push({ method: "tools/call", params: { ...params, _meta: meta }, status: 200, result: body.result, error: body.error, events: [] });
      return body.result;
    };
    const first = await send();
    if (first?.resultType === "input_required") {
      const reply = (k) => (c.answer === undefined || c.answer === "decline" ? { action: "decline" } : { action: "accept", content: c.answer });
      await send({ inputResponses: Object.fromEntries(Object.keys(first.inputRequests ?? {}).map((k) => [k, reply(k)])) });
    }
    await c.after?.(backend.ctl);
    return { text: "DONE", cost: 0, traffic, seconds: 0, input: "", elicitations: [] };
  }

  // --- what a case sees ------------------------------------------------------------------------
  const resultText = (t) => (t.result?.content ?? []).map((c) => c.text ?? "").join("\n");
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
    /** Notifications the server sent down the client's change subscription. */
    events: () => slice.filter((t) => t.method === "subscriptions/listen").flatMap((t) => t.events),
    capabilities: () => slice.map(capsOf).find(Boolean),
    clientInfo: () => slice.map((t) => t.params?._meta?.["io.modelcontextprotocol/clientInfo"]).find(Boolean),
    protocol: () => slice.map((t) => t.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? t.protocolHeader).find(Boolean),
  });

  function judge(c, run) {
    const checks = [];
    const facts = {};
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: typeof detail === "string" ? detail.slice(0, 500) : detail === undefined ? undefined : JSON.stringify(detail).slice(0, 500) }) });
    try {
      c.verify({ answer: run.text, traffic: view(run.traffic), note: backend.note, vault: backend.vault, elicitations: run.elicitations, during: run.during, check, fact: (k, v) => (facts[k] = v), world });
    } catch (e) {
      check("verify ran", false, e.message);
    }
    if (run.raw) check("claude ran", false, run.raw);
    if (run.during && run.during !== "done") check("the mid-session step ran", false, run.during);
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
      if (!dry && c.directed && !c.writes && !verdict.ok && verdict.checks[0]?.name === "called as directed" && !verdict.checks[0].ok) {
        retried = true;
        run = await session(c);
        verdict = judge(c, run);
      }
      if (dump) allTraffic.push({ id: c.id, attempt: i + 1, traffic: run.traffic, elicitations: run.elicitations });
      attempts.push({ ...verdict, retried, cost: run.cost, seconds: run.seconds, answer: run.text.slice(0, 500), methods: run.traffic.map((t) => (t.method === "tools/call" || t.method === "prompts/get" ? `${t.method} ${t.params?.name}` : t.method)).filter(Boolean) });
    }
    const passes = attempts.filter((a) => a.ok).length;
    // Where the model decides, one run proves little: such a case runs several times and must pass in most.
    const need = c.need ?? (times === 1 ? 1 : Math.floor(times / 2) + 1);
    // A known gap is a case that fails for a reason outside the server, written down in the case. It is
    // reported as a gap, never as a pass, and it is reported loudly if it starts passing.
    const result = { ...(c.knownGap ? { knownGap: c.knownGap } : {}), id: c.id, mode, area: c.area, kind: c.directed ? "directed" : c.tools === false ? "client" : "agent", what: c.what, input: typeof c.input === "function" ? c.input(world) : c.input, ok: passes >= need, passes, times, need, attempts };
    const first = attempts.find((a) => !a.ok) ?? attempts[0];
    console.log(`${result.ok ? (c.knownGap ? "PASS (a known gap has closed)" : "PASS") : c.knownGap ? "GAP " : "FAIL"}  ${c.id.padEnd(30)} ${times > 1 ? `${passes}/${times}  ` : ""}${c.what}${attempts.some((a) => a.retried) ? "  (retried)" : ""}`);
    for (const x of first.checks.filter((x) => !x.ok)) console.log(`        ✗ ${x.name}${x.detail ? `: ${String(x.detail).replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
    for (const [k, v] of Object.entries(first.facts)) console.log(`        · ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return result;
  }

  // --- setup cases first, then those that only read (several at once), then the writers, in order ---
  console.log(`\n== ${server} · ${mode} · ${selected.length} case(s)`);
  const results = [];
  const stage = (name) => selected.filter((c) => (c.stage ?? (c.writes ? "write" : "read")) === name);
  for (const c of stage("setup")) results.push(await runCase(c));
  const queue = [...stage("read")];
  await Promise.all(
    Array.from({ length: Math.max(1, jobs) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) results.push(await runCase(c));
    }),
  );
  for (const c of stage("write")) results.push(await runCase(c));
  results.sort((a, b) => selected.findIndex((c) => c.id === a.id) - selected.findIndex((c) => c.id === b.id));

  await backend.finish(selected);
  rmSync(work, { recursive: true, force: true });
  if (dump) {
    mkdirSync(join(here, "results"), { recursive: true });
    writeFileSync(join(here, `results/traffic-${server}-${mode}.json`), JSON.stringify(allTraffic, null, 2) + "\n");
  }
  return results;
}

// --- run every mode asked for, and report ----------------------------------------------------

const results = [];
for (const mode of modes) results.push(...(await runMode(mode)));
if (!results.length) throw new Error("No case matches.");

const passed = results.filter((r) => r.ok).length;
const gaps = results.filter((r) => !r.ok && r.knownGap);
const failed = results.filter((r) => !r.ok && !r.knownGap);
const cost = results.reduce((n, r) => n + r.attempts.reduce((m, a) => m + a.cost, 0), 0);
const client = results.flatMap((r) => r.attempts.map((a) => a.facts["client name"])).find(Boolean);
const label = `${server}${modes.length === 1 ? `-${modes[0]}` : ""}${dry ? "-dry" : ""}${agentModel ? `-${agentModel}` : ""}`;
const stamp = { at: new Date().toISOString(), server, modes, client, passed, gaps: gaps.length, failed: failed.length, total: results.length, cost };
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, `results/latest-${label}.json`), JSON.stringify({ ...stamp, results }, null, 2) + "\n");
const groups = [...new Set(results.map((r) => `${r.mode} / ${r.area}`))];
const md = [
  `# MCP client evals: ${label}`,
  "",
  `${stamp.at} · ${client ?? "client not recorded"} · ${passed} passed, ${failed.length} failed, ${gaps.length} known gap(s), of ${results.length} · $${cost.toFixed(2)}`,
  "",
  "| Mode / area | Cases | Passed |",
  "|---|---|---|",
  ...groups.map((g) => `| ${g} | ${results.filter((r) => `${r.mode} / ${r.area}` === g).length} | ${results.filter((r) => `${r.mode} / ${r.area}` === g && r.ok).length} |`),
  "",
  "| Mode | Case | Kind | Result | What it shows |",
  "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.mode} | ${r.id} | ${r.kind} | ${r.ok ? "pass" : r.knownGap ? "known gap" : "**fail**"}${r.times > 1 ? ` ${r.passes}/${r.times}` : ""}${r.attempts.some((a) => a.retried) ? " (retried)" : ""} | ${r.what} |`),
  "",
  ...gaps.flatMap((r) => [`## Known gap: ${r.id}`, "", r.knownGap, ""]),
  ...failed.flatMap((r) => [`## ${r.id}`, "", ...(r.attempts.find((a) => !a.ok)?.checks.filter((x) => !x.ok).map((x) => `- ${x.name}${x.detail ? `: ${String(x.detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`) ?? []), ""]),
].join("\n");
writeFileSync(join(here, `results/latest-${label}.md`), md + "\n");
console.log(`\n${passed} passed, ${failed.length} failed, ${gaps.length} known gap(s), of ${results.length} · ${server} · ${modes.join(", ")} · $${cost.toFixed(2)} · evals/mcp-client/results/latest-${label}.md${keep ? " · vault changes kept" : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
