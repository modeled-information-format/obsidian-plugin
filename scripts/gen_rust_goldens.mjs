// Goldens produced by mif-rs itself (via the spikes/mif-wasm build), for
// behaviour that only has a Rust reference: ontology `extends` resolution.
//   (cd spikes/mif-wasm && wasm-pack build --release --target nodejs --out-dir pkg-node)
//   node scripts/gen_rust_goldens.mjs
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const wasm = require("../spikes/mif-wasm/pkg-node/mif_wasm.js");
const dir = "tests/fixtures/ontologies/corpus";
const corpus = readdirSync(dir).filter((f) => f.endsWith(".ontology.yaml")).sort().map((f) => readFileSync(join(dir, f), "utf8"));

const run = (texts, id) => {
  try {
    return JSON.parse(wasm.resolveChain(JSON.stringify(texts), id));
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
};
const def = (id, ext = []) => `ontology:\n  id: ${id}\n  version: "1.0.0"\n${ext.length ? `  extends: [${ext.join(", ")}]\n` : ""}`;

const out = { corpus: {}, synthetic: {} };
for (const text of corpus) {
  const id = /^\s+id:\s*(\S+)/m.exec(text)[1];
  out.corpus[id] = run(corpus, id);
}
const cases = {
  diamond: [[def("a"), def("b", ["a"]), def("c", ["a"]), def("d", ["b", "c"])], "d"],
  cycle: [[def("x", ["y"]), def("y", ["x"])], "x"],
  self: [[def("s", ["s"])], "s"],
  missingParent: [[def("child", ["ghost"])], "child"],
  missingRoot: [[def("a")], "nope"],
  order: [[def("p1"), def("p2"), def("p3", ["p2"]), def("kid", ["p3", "p1"])], "kid"],
};
for (const [name, [texts, id]] of Object.entries(cases)) out.synthetic[name] = { texts, id, result: run(texts, id) };
writeFileSync("tests/golden/ontology-chains.json", JSON.stringify(out, null, 2) + "\n");
console.log(`chains for ${Object.keys(out.corpus).length} corpus ontologies, ${Object.keys(cases).length} synthetic cases`);
