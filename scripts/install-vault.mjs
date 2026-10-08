// Install the built plugin into test-vault and stage the edge fixtures, so
// the vault can be opened in Obsidian for the spikes. Everything written
// here is gitignored (test-vault/.obsidian/, test-vault/_fixtures/).
//   npm run build && npm run install-vault
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(".");
const vault = join(root, "test-vault");
const pluginDir = join(vault, ".obsidian", "plugins", "mif");

if (!existsSync(join(root, "main.js"))) throw new Error("main.js missing: run `npm run build` first");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(root, f), join(pluginDir, f));

// Enable the plugin and its developer commands on first open.
writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["mif"]) + "\n");
if (!existsSync(join(pluginDir, "data.json"))) {
  writeFileSync(join(pluginDir, "data.json"), JSON.stringify({ showDevCommands: true }) + "\n");
}

// Fixture bundles for manual testing: edge cases (Spike B),
// relationships (add "_fixtures/rel" as a bundle root), and MIF 0.1.
const STAGE = {
  edge: join(root, "tests", "fixtures", "edge"),
  rel: join(root, "tests", "fixtures", "rel"),
  legacy: join(root, "tests", "fixtures", "mif", "legacy-0.1-bundle"),
};
rmSync(join(vault, "_fixtures"), { recursive: true, force: true });
for (const [name, src] of Object.entries(STAGE)) {
  cpSync(src, join(vault, "_fixtures", name), { recursive: true });
}
console.log(`installed plugin into ${pluginDir}\nstaged fixtures into ${join(vault, "_fixtures")}: ${Object.keys(STAGE).join(", ")}`);
