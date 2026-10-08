// Check the plugin against an in-flight MIF ref without vendoring it:
//   node scripts/mif-align.mjs chore/concept-terminology
// Reads the ref's schemas with `git show` (the MIF checkout is never
// touched), lists what differs from ./schemas, reports changes to the
// scripts the goldens come from, then runs the test suite with validators
// compiled from the ref's schemas. The vendored validators are always
// rebuilt afterwards. Exit code: 0 aligned, 1 tests fail, 2 usage/git error.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ref = process.argv[2];
if (!ref) {
  console.error("usage: node scripts/mif-align.mjs <MIF ref>");
  process.exit(2);
}
const repo = resolve(process.env.MIF_REPO ?? "../MIF");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const source = JSON.parse(readFileSync("schemas/SOURCE.json", "utf8"));
const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
console.log(`MIF ${ref} @ ${commit.slice(0, 7)} vs vendored ${source.commit.slice(0, 7)} (${source.branch})\n`);

// 1. Schemas.
const dir = mkdtempSync(join(tmpdir(), "mif-align-"));
const changed = [];
for (const f of source.files) {
  let text;
  try {
    text = git("show", `${commit}:schema/${f}`);
  } catch {
    changed.push(`${f} (removed at ref)`);
    continue;
  }
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
  if (text !== readFileSync(join("schemas", f), "utf8")) changed.push(f);
}
const added = git("ls-tree", "-r", "--name-only", commit, "schema/")
  .split("\n").filter((f) => f.endsWith(".schema.json")).map((f) => f.slice("schema/".length))
  .filter((f) => !source.files.includes(f));
console.log(`Schemas changed: ${changed.length ? changed.join(", ") : "none"}`);
if (added.length) console.log(`Schemas added at ref (not vendored): ${added.join(", ")}`);

// 2. Golden sources (scripts/gen_golden.py runs these).
const GOLDEN_SOURCES = ["scripts/mif_convert.py", "scripts/okf_validate.py", "scripts/migrate_0_1_to_1_0.py", "scripts/validate-ontologies.py", "ontologies/"];
const goldenDiff = git("diff", "--stat", source.commit, commit, "--", ...GOLDEN_SOURCES, "examples/").trim();
console.log(`Golden sources changed: ${goldenDiff ? `\n${goldenDiff}\n  → regenerate goldens after vendoring (npm run golden)` : "none"}`);

// 3. Tests against the ref's schemas.
const run = (cmd, args, env = {}) => spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;
let status = 0;
try {
  if (run("node", ["scripts/build-validators.mjs"], { MIF_SCHEMAS_DIR: dir }) !== 0) throw new Error("validator build failed");
  console.log(`\nRunning the suite with ${ref}'s schemas…`);
  status = run("npx", ["vitest", "run", "--reporter=dot"]);
} finally {
  run("node", ["scripts/build-validators.mjs"]);
  rmSync(dir, { recursive: true, force: true });
}
console.log(status === 0 ? `\nAligned: the suite passes against ${ref}.` : `\nNot aligned: tests fail against ${ref} (vendored validators restored).`);
process.exit(status === 0 ? 0 : 1);
