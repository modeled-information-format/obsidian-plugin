// Bundle bench.ts (TS engine + wasm-pack web build) and run it under Node.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "mif-bench-")), "bench.cjs");
await esbuild.build({
  entryPoints: ["spikes/mif-wasm/bench.ts"],
  bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "warning",
  define: { "import.meta.url": "undefined" },
});
const env = { ...process.env, PLUGIN_ROOT: resolve(".") };
process.stdout.write(execFileSync("node", [out], { env, cwd: resolve("spikes/mif-wasm"), encoding: "utf8" }));
