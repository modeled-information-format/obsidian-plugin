// Runs the mif-vault-memory skill's test cases through Claude Code, each with
// and without the skill, against a fresh in-memory vault per run.
//   node scripts/eval-skill.mjs [--iteration N] [--only case,case] [--model id]
//   node scripts/eval-skill.mjs --live <vault folder> --cases-file <json>
//     reads only: runs cases from a JSON file ([{name, prompt, assertions}]) against the server of a
//     vault that is open in Obsidian, offering the run the read tools and nothing else.
// Output: skills/mif-vault-memory-workspace/iteration-N/<case>/<with_skill|without_skill>/

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { startMemory } from "../evals/mcp-client/memory.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = join(repo, "skills/mif-vault-memory");
const flag = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1];
};
const iteration = flag("--iteration") ?? "1";
const only = flag("--only")?.split(",");
const model = flag("--model");
const work = join(repo, "skills/mif-vault-memory-workspace", `iteration-${iteration}`);
const live = flag("--live");
const casesFile = flag("--cases-file");
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
        else seed[relative(join(dir, "files"), p)] = readFileSync(p, "utf8");
      }
    };
    if (existsSync(join(dir, "files"))) walk(join(dir, "files"));
    return { name: e.name, prompt, assertions, seed };
  });

function claude(cwd, prompt, config) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", config, "--strict-mcp-config", "--allowedTools", live ? [...READ_TOOLS, "Skill"].join(",") : `mcp__${SERVER},Skill,Read,Glob,Grep`, "--max-turns", "25", ...(model ? ["--model", model] : [])];
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function run(c, config) {
  const started = Date.now();
  let vault;
  if (live) {
    const d = JSON.parse(readFileSync(join(live, ".obsidian/plugins/mif/data.json"), "utf8"));
    vault = { port: d.mcpPort, token: d.mcpToken, paths: () => [], read: () => undefined };
  } else {
    vault = await startMemory({ mcpAllowWrites: true, mcpWriteLimit: 500, mcpPurpose: "API gateway operations: rate limits, incidents and runbooks" });
  }
  for (const [path, text] of Object.entries(c.seed ?? {})) await vault.create(path, text);
  const snapshot = () => Object.fromEntries(vault.paths().map((p) => [p, vault.read(p)]));
  const before = snapshot();
  // A project folder of its own: the skill is there for one configuration and absent for the other.
  const project = join(tmpdir(), `mif-skill-eval-${c.name}-${config}-${Date.now()}`);
  mkdirSync(project, { recursive: true });
  if (config === "with_skill") cpSync(skill, join(project, ".claude/skills/mif-vault-memory"), { recursive: true, filter: (p) => !p.includes("/evals") });
  const mcp = join(project, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: `http://127.0.0.1:${vault.port}/mcp`, headers: { Authorization: `Bearer ${vault.token}` } } } }));
  const raw = await claude(project, c.prompt, mcp);
  const events = raw.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const calls = events.flatMap((e) => (e.type === "assistant" ? (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => ({ tool: b.name.replace(`mcp__${SERVER}__`, ""), input: b.input })) : []));
  const result = events.find((e) => e.type === "result") ?? {};
  const returned = events.flatMap((e) => (e.type === "user" ? (e.message?.content ?? []).filter((b) => b.type === "tool_result") : [])).reduce((n, b) => n + JSON.stringify(b.content ?? "").length, 0);
  const after = snapshot();
  const changed = Object.fromEntries(Object.entries(after).filter(([p, t]) => before[p] !== t));
  await vault.close?.();
  rmSync(project, { recursive: true, force: true });

  const dir = join(work, c.name, config);
  mkdirSync(join(dir, "outputs"), { recursive: true });
  writeFileSync(join(dir, "outputs/answer.md"), `${result.result ?? "(no final message)"}\n`);
  writeFileSync(join(dir, "outputs/tool-calls.md"), `${calls.map((k, i) => `${i + 1}. \`${k.tool}\` ${JSON.stringify(k.input)}`).join("\n") || "(no tool calls)"}\n`);
  writeFileSync(join(dir, "outputs/notes-changed.md"), `${Object.entries(changed).map(([p, t]) => `## ${p}\n\n\`\`\`markdown\n${t}\n\`\`\`\n`).join("\n") || "(no note was created or changed)"}\n`);
  writeFileSync(join(dir, "outputs/notes-changed.json"), JSON.stringify({ created: Object.keys(changed).filter((p) => before[p] === undefined), changed, calls }, null, 1));
  const tokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0);
  const ms = Date.now() - started;
  writeFileSync(join(dir, "timing.json"), JSON.stringify({ total_tokens: tokens, duration_ms: ms, total_duration_seconds: Math.round(ms / 100) / 10, cost_usd: result.total_cost_usd, tool_calls: calls.filter((k) => k.tool.startsWith("mif_vault_")).length, turns: result.num_turns, tool_result_chars: returned }, null, 2));
  console.log(`${c.name} · ${config}: ${calls.length} tool call(s), ${Object.keys(changed).length} note(s) changed, ${Math.round(ms / 1000)}s`);
}

for (const c of cases) {
  mkdirSync(join(work, c.name), { recursive: true });
  writeFileSync(join(work, c.name, "eval_metadata.json"), JSON.stringify({ eval_name: c.name, prompt: c.prompt, assertions: c.assertions }, null, 2));
}
await Promise.all(cases.flatMap((c) => ["with_skill", "without_skill"].map((config) => run(c, config))));
process.exit(0);
