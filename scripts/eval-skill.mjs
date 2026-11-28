// Runs the mif-vault-memory skill's test cases through Claude Code, each with
// and without the skill, against a fresh in-memory vault per run.
//   node scripts/eval-skill.mjs [--iteration N] [--only case,case] [--model id] [--concurrency N]
//   node scripts/eval-skill.mjs --live <vault folder> --cases-file <json>
//     reads only: runs cases from a JSON file ([{name, prompt, assertions}]) against the server of a
//     vault that is open in Obsidian, offering the run the read tools and nothing else.
// Output: skills/mif-vault-memory-workspace/iteration-N/<case>/<with_skill|without_skill>/
// Exits 1 when any run failed; a failed run's timing.json says why in "failed" and has null measures.
// Runs load project settings only, so the model is Claude Code's default unless --model names one;
// timing.json records the model each run used.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startMemory } from "../evals/mcp-client/memory.mjs";

const SKILL_NAME = "mif-vault-memory";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = join(repo, "skills", SKILL_NAME);
const flag = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1];
};
const iteration = flag("--iteration") ?? "1";
const only = flag("--only")?.split(",");
const model = flag("--model");
const concurrency = Math.max(1, Number(flag("--concurrency") ?? 4) || 4);
const work = join(repo, `skills/${SKILL_NAME}-workspace`, `iteration-${iteration}`);
const live = flag("--live");
const casesFile = flag("--cases-file");
if (live && !casesFile) {
  // The built-in cases write to the vault and seed notes into it; a live vault gets neither.
  console.error("--live needs --cases-file: the built-in cases write notes and are not run against a real vault.");
  process.exit(2);
}
const SERVER = live ? "mif-vault-live" : "mif-vault-gateway-ops";
const READ_TOOLS = ["search_concepts", "get_concept", "list_relationships", "list_concepts", "list_entities", "get_status", "list_entity_types"].map((t) => `mcp__${SERVER}__mif_vault_${t}`);

const cases = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8")).filter((c) => !only || only.includes(c.name))
  : readdirSync(join(skill, "evals"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!only || only.includes(e.name)))
      .map((e) => {
        const dir = join(skill, "evals", e.name);
        const prompt = readFileSync(join(dir, "prompt.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
        const assertions = readdirSync(join(dir, "graders")).sort().map((f) => readFileSync(join(dir, "graders", f), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim());
        // Notes the case needs in the vault before the run: everything under its files/ folder, at the same path.
        const seed = {};
        const walk = (d) => {
          for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else seed[relative(join(dir, "files"), p).split(sep).join("/")] = readFileSync(p, "utf8");
          }
        };
        if (existsSync(join(dir, "files"))) walk(join(dir, "files"));
        return { name: e.name, prompt, assertions, seed };
      });

const unknown = (only ?? []).filter((n) => !cases.some((c) => c.name === n));
if (unknown.length || !cases.length) {
  console.error(unknown.length ? `No such case: ${unknown.join(", ")}` : "No cases to run.");
  process.exit(2);
}

/** Run Claude Code once. Resolves with its output, its exit code, and the reason it could not run, if any. */
function claude(cwd, prompt, config) {
  return new Promise((resolve) => {
    // Only the project folder's own skills and settings load, so a copy of the skill installed for
    // the user cannot reach the run that is meant to go without it.
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--mcp-config", config, "--strict-mcp-config", "--allowedTools", live ? [...READ_TOOLS, "Skill"].join(",") : `mcp__${SERVER},Skill,Read,Glob,Grep`, "--max-turns", "25", ...(model ? ["--model", model] : [])];
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let problem;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => {
      problem = "timed out after 600 s";
      child.kill("SIGKILL");
    }, 600_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out, code: null, problem: `claude could not be started: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, code, problem });
    });
  });
}

/** Why this run's numbers cannot be used, or undefined when they can. */
function failure(config, ran, events, result, calls) {
  if (ran.problem) return ran.problem;
  if (!result) return `claude ended without a result (exit code ${ran.code})`;
  if (result.subtype !== "success") return `claude reported ${result.subtype ?? "an error"}`;
  if (result.is_error) return `claude reported an error: ${String(result.result ?? "").slice(0, 160)}`;
  if (ran.code !== 0) return `claude exited with code ${ran.code}`;
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  // Without the vault's server a run answers from general knowledge, cheaply, and measures nothing.
  const server = (init?.mcp_servers ?? []).find((s) => s.name === SERVER);
  if (server?.status !== "connected") return `the vault's server was not connected (${server?.status ?? "not listed"})`;
  const has = (init?.skills ?? []).includes(SKILL_NAME);
  if (config === "with_skill" && !has) return "the skill was not offered to the run that should have it";
  if (config === "without_skill" && (has || calls.some((k) => k.tool === "Skill" && k.input?.skill === SKILL_NAME))) return "the skill reached the run that should go without it";
  return undefined;
}

// Project folders in use, each holding a server token: removed when a run ends, and when the script is interrupted.
const projects = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const p of projects) rmSync(p, { recursive: true, force: true });
    process.exit(130);
  });
}

/** Record a run that produced nothing usable, so no earlier result is left standing in its place. */
function recordFailure(c, config, reason) {
  const dir = join(work, c.name, config);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "timing.json"), JSON.stringify({ failed: reason, total_tokens: null, duration_ms: null, total_duration_seconds: null, cost_usd: null, tool_calls: null, turns: null, tool_result_chars: null }, null, 2));
  console.log(`${c.name} · ${config}: FAILED (${reason})`);
}

async function run(c, config) {
  const started = Date.now();
  const dir = join(work, c.name, config);
  // Start clean: a result from an earlier run of this iteration must not be read as this run's.
  rmSync(dir, { recursive: true, force: true });
  let vault;
  let project;
  try {
    if (live) {
      const d = JSON.parse(readFileSync(join(live, ".obsidian/plugins/mif/data.json"), "utf8"));
      vault = { port: d.mcpPort, token: d.mcpToken, paths: () => [], read: () => undefined };
    } else {
      vault = await startMemory({ mcpAllowWrites: true, mcpWriteLimit: 500, mcpPurpose: "API gateway operations: rate limits, incidents and runbooks" });
      for (const [path, text] of Object.entries(c.seed ?? {})) await vault.create(path, text);
    }
    const snapshot = () => Object.fromEntries(vault.paths().map((p) => [p, vault.read(p)]));
    const before = snapshot();
    // A project folder of its own, readable by this user only: the skill is there for one
    // configuration and absent for the other, and the server's token is in its mcp.json.
    project = mkdtempSync(join(tmpdir(), "mif-skill-eval-"));
    projects.add(project);
    if (config === "with_skill") cpSync(skill, join(project, ".claude/skills", SKILL_NAME), { recursive: true, filter: (p) => relative(skill, p).split(sep)[0] !== "evals" });
    const mcp = join(project, "mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: `http://127.0.0.1:${vault.port}/mcp`, headers: { Authorization: `Bearer ${vault.token}` } } } }), { mode: 0o600 });
    const ran = await claude(project, c.prompt, mcp);
    const events = ran.out.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const calls = events.flatMap((e) => (e.type === "assistant" ? (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => ({ tool: b.name.replace(`mcp__${SERVER}__`, ""), input: b.input })) : []));
    const result = events.find((e) => e.type === "result");
    const failed = failure(config, ran, events, result, calls);
    const returned = events.flatMap((e) => (e.type === "user" ? (e.message?.content ?? []).filter((b) => b.type === "tool_result") : [])).reduce((n, b) => n + JSON.stringify(b.content ?? "").length, 0);
    const after = snapshot();
    const changed = Object.fromEntries(Object.entries(after).filter(([p, t]) => before[p] !== t));

    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/answer.md"), `${result?.result ?? "(no final message)"}\n`);
    writeFileSync(join(dir, "outputs/tool-calls.md"), `${calls.map((k, i) => `${i + 1}. \`${k.tool}\` ${JSON.stringify(k.input)}`).join("\n") || "(no tool calls)"}\n`);
    writeFileSync(join(dir, "outputs/notes-changed.md"), `${Object.entries(changed).map(([p, t]) => `## ${p}\n\n\`\`\`markdown\n${t}\n\`\`\`\n`).join("\n") || "(no note was created or changed)"}\n`);
    writeFileSync(join(dir, "outputs/notes-changed.json"), JSON.stringify({ created: Object.keys(changed).filter((p) => before[p] === undefined), changed, calls }, null, 1));
    const u = result?.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const ms = Date.now() - started;
    const vaultCalls = calls.filter((k) => k.tool.startsWith("mif_vault_")).length;
    const measured = { total_tokens: tokens, duration_ms: ms, total_duration_seconds: Math.round(ms / 100) / 10, cost_usd: result?.total_cost_usd, tool_calls: vaultCalls, turns: result?.num_turns, tool_result_chars: returned };
    const usedModel = events.find((e) => e.type === "system" && e.subtype === "init")?.model ?? null;
    if (failed) {
      // A failed run keeps what it produced for reading, under "partial"; its measures are null so nothing totals them.
      recordFailure(c, config, failed);
      writeFileSync(join(dir, "timing.json"), JSON.stringify({ failed, model: usedModel, ...Object.fromEntries(Object.keys(measured).map((k) => [k, null])), partial: measured }, null, 2));
      return false;
    }
    writeFileSync(join(dir, "timing.json"), JSON.stringify({ failed: null, model: usedModel, ...measured }, null, 2));
    console.log(`${c.name} · ${config}: ${vaultCalls} vault call(s), ${Object.keys(changed).length} note(s) changed, ${Math.round(ms / 1000)}s`);
    return true;
  } finally {
    if (project) {
      rmSync(project, { recursive: true, force: true });
      projects.delete(project);
    }
    await vault?.close?.();
  }
}

for (const c of cases) {
  mkdirSync(join(work, c.name), { recursive: true });
  writeFileSync(join(work, c.name, "eval_metadata.json"), JSON.stringify({ eval_name: c.name, prompt: c.prompt, assertions: c.assertions }, null, 2));
}
// A few runs at a time: starting them all at once invites rate limits, which show up as failed runs.
const queue = cases.flatMap((c) => ["with_skill", "without_skill"].map((config) => [c, config]));
let failures = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const ok = await run(...job).catch((e) => {
        recordFailure(...job, e.message);
        return false;
      });
      if (!ok) failures += 1;
    }
  }),
);
if (failures) console.error(`${failures} run(s) failed; their numbers are marked "failed" in timing.json and must not be totalled.`);
process.exit(failures ? 1 : 0);
