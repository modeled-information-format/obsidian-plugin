// Vendor the canonical MIF JSON Schemas into ./schemas so the plugin
// validates offline (spec §2.4 local-first). Records the source commit in
// schemas/SOURCE.json; re-run after the MIF repo changes.
//   MIF_REPO=/path/to/MIF npm run sync-schemas               # the checkout as it is
//   MIF_REPO=/path/to/MIF MIF_REF=origin/main npm run sync-schemas  # a ref, read with git show
// With MIF_REF the MIF checkout is never touched (it may be on another branch).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.env.MIF_REPO) {
  console.error("set MIF_REPO to the path of a MIF checkout");
  process.exit(2);
}
const repo = resolve(process.env.MIF_REPO);
const ref = process.env.MIF_REF;
const src = join(repo, "schema");
const dest = resolve("schemas");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();

let commit;
let branch;
const listed = [];
if (ref) {
  commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  branch = ref;
  for (const f of git("ls-tree", "-r", "--name-only", commit, "schema/").split("\n")) {
    const rel = f.slice("schema/".length);
    if (/^(definitions\/|ontology\/)?[^/]+\.schema\.json$/.test(rel)) listed.push(rel);
  }
} else {
  const dirty = git("status", "--porcelain", "--", "schema");
  if (dirty) throw new Error(`refusing to vendor uncommitted schema changes:\n${dirty}`);
  commit = git("rev-parse", "HEAD");
  branch = git("branch", "--show-current");
  for (const sub of ["", "definitions", "ontology"]) {
    for (const f of readdirSync(join(src, sub)).filter((f) => f.endsWith(".schema.json"))) listed.push(sub ? `${sub}/${f}` : f);
  }
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, "definitions"), { recursive: true });
mkdirSync(join(dest, "ontology"), { recursive: true });
for (const f of listed) {
  if (ref) writeFileSync(join(dest, f), `${git("show", `${commit}:schema/${f}`)}\n`);
  else cpSync(join(src, f), join(dest, f));
}
const source = {
  repo: "modeled-information-format/MIF",
  commit,
  branch,
  syncedAt: new Date().toISOString(),
  files: listed.sort(),
};
writeFileSync(join(dest, "SOURCE.json"), JSON.stringify(source, null, 2) + "\n");
console.log(`vendored ${listed.length} schemas from ${commit.slice(0, 7)}${ref ? ` (${ref})` : ""}`);
