// ESLint with Obsidian's community-review rules (eslint-plugin-obsidianmd).
// Run from the repo root: npm run lint
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig([
  { ignores: ["**/generated/**", "main.js", "spikes/**", "tests/**", "scripts/**", "tools/**", "test-vault/**", "node_modules/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { project: resolve(root, "tsconfig.json"), tsconfigRootDir: root },
    },
    rules: {
      // MIF's own vocabulary keeps its casing in UI text.
      "obsidianmd/ui/sentence-case": ["warn", {
        acronyms: ["MIF", "JSON-LD", "JSON", "ID", "IDs", "URN", "URI", "URL", "OKF", "TTL", "UUID", "YAML", "CRLF", "LF", "PROV", "SBOM", "L1", "L2", "L3", "CLI", "API"],
        brands: ["Obsidian", "Hugging Face", "Dataview", "DataviewJS", "Bases", "mif-cli", "mif-spec.dev", "mif-rs", "Copier", "all-MiniLM-L6-v2"],
        // Placeholders and identifiers, not prose: ids and paths, ISO examples,
        // markdown headings, the .mif folder, sample names.
        ignoreRegex: ["^[a-z0-9-]+(/[a-z0-9-]+)*$", "^[0-9TZ:+-]+$", "^YYYY-MM-DD$", "^key: value$", "## ", "\\.mif\\b", "^Jane Doe$", "“New entity…”"],
      }],
    },
  },
]);
