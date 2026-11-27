// Start the in-memory server (memory-vault.ts) from Node: bundle it with esbuild,
// load the vault's content from tracked files, and hand back its controls.

import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as net from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");

// The same fixtures scripts/install-vault.mjs stages into a live test vault, under the same names.
const STAGE = {
  edge: "tests/fixtures/edge",
  rel: "tests/fixtures/rel",
  legacy: "tests/fixtures/mif/legacy-0.1-bundle",
  memories: "tests/fixtures/memories",
  temporal: "tests/fixtures/temporal",
  citations: "tests/fixtures/citations",
  bases: "tests/fixtures/bases",
};
const TEXT = /\.(md|ya?ml|json|jsonld|base|txt)$/i;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.test(e.name) && statSync(p).size < 2_000_000) out.push(p);
  }
  return out;
}

/** The vault's files, from what git tracks: the test vault's own notes, and the staged fixtures. */
export function vaultContent() {
  const notes = {};
  const dot = {};
  const put = (vaultPath, file) => ((vaultPath.split("/").some((s) => s.startsWith(".")) ? dot : notes)[vaultPath] = readFileSync(file, "utf8"));
  const vault = join(repo, "test-vault");
  for (const e of readdirSync(vault, { withFileTypes: true })) {
    // Dot folders and _fixtures in a live test vault are untracked copies; here they come from their sources.
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const p = join(vault, e.name);
    for (const f of e.isDirectory() ? walk(p) : TEXT.test(e.name) ? [p] : []) put(relative(vault, f).split("\\").join("/"), f);
  }
  for (const [name, src] of Object.entries(STAGE)) for (const f of walk(join(repo, src))) put(`_fixtures/${name}/${relative(join(repo, src), f).split("\\").join("/")}`, f);
  // One ontology of the vault's own, so that ontologies are served and entity types have a source besides the core ones.
  dot[".mif/ontologies/eval-ops.ontology.yaml"] = readFileSync(join(here, "fixtures/eval-ops.ontology.yaml"), "utf8");
  return { notes, dot };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let bundled;
async function bundle() {
  if (bundled) return bundled;
  const out = join(here, "results/.memory-vault.mjs");
  mkdirSync(dirname(out), { recursive: true });
  await build({
    entryPoints: [join(here, "memory-vault.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    alias: { obsidian: join(repo, "tests/support/obsidian-stub.ts") },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "silent",
  });
  bundled = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
  return bundled;
}

/** Start a fresh in-memory vault with these plugin settings. */
export async function startMemory(settings = {}) {
  const { startMemoryVault } = await bundle();
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const vault = await startMemoryVault({ ...vaultContent(), settings, port, token });
  return { ...vault, port, token };
}
