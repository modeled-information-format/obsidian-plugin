// Vendor the canonical MIF JSON Schemas into ./schemas so the plugin
// validates offline (spec §2.4 local-first). Records the source commit in
// schemas/SOURCE.json; re-run after the MIF repo changes.
//   MIF_REPO=../MIF npm run sync-schemas
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(process.env.MIF_REPO ?? "../MIF");
const src = join(repo, "schema");
const dest = resolve("schemas");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

const dirty = git("status", "--porcelain", "--", "schema");
if (dirty) throw new Error(`refusing to vendor uncommitted schema changes:\n${dirty}`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, "definitions"), { recursive: true });
mkdirSync(join(dest, "ontology"), { recursive: true });
const files = [];
for (const sub of ["", "definitions", "ontology"]) {
  for (const f of readdirSync(join(src, sub)).filter((f) => f.endsWith(".schema.json"))) {
    cpSync(join(src, sub, f), join(dest, sub, f));
    files.push(join(sub, f));
  }
}
const source = {
  repo: "modeled-information-format/MIF",
  commit: git("rev-parse", "HEAD"),
  branch: git("branch", "--show-current"),
  syncedAt: new Date().toISOString(),
  files: files.sort(),
};
writeFileSync(join(dest, "SOURCE.json"), JSON.stringify(source, null, 2) + "\n");
console.log(`vendored ${files.length} schemas from ${source.commit.slice(0, 7)}`);
