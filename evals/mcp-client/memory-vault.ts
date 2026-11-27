// The server for evals, without Obsidian: the real endpoint, service, host and
// manager, over the in-memory vault the unit tests use. esbuild bundles this
// with "obsidian" aliased to tests/support/obsidian-stub.ts (see memory.mjs).
//
// What it cannot do: there is no mif-cli here, so nothing that needs the
// vector store runs (search, the store and gap reports, ingest, the duplicate
// check). Those are evaluated against a live vault.

import * as http from "node:http";
import { MarkdownView, memoryAdapter, memoryApp, notices } from "../../tests/support/obsidian-stub";
import { MifCli } from "../../src/cliBridge";
import { MifManager } from "../../src/manager";
import { startEndpoint } from "../../src/mcp/http";
import { McpService, VaultMcpHost } from "../../src/mcpHost";
import { OntologyStore } from "../../src/ontologyStore";
import { DEFAULT_SETTINGS, type MifSettings } from "../../src/settings";

export interface MemoryVaultOptions {
  /** Every file outside a dot folder, by vault path. */
  notes: Record<string, string>;
  /** Files in dot folders (.mif/…), which Obsidian's vault does not index. */
  dot: Record<string, string>;
  settings: Partial<MifSettings>;
  port: number;
  token: string;
}

export async function startMemoryVault(opts: MemoryVaultOptions) {
  const v = memoryApp(opts.notes);
  const dotFiles = new Map(Object.entries(opts.dot));
  (v.app.vault as { adapter: unknown }).adapter = memoryAdapter(dotFiles);
  const settings: MifSettings = { ...DEFAULT_SETTINGS, downloadOntologies: false, mcpEnabled: true, mcpPort: opts.port, mcpToken: opts.token, mcpPurpose: "The plugin's test vault, in memory, for evaluation", ...opts.settings };
  const pluginDir = ".obsidian/plugins/mif";
  const store = new OntologyStore(v.app as never, pluginDir);
  await store.loadCache();
  const manager = new MifManager(v.app as never, () => settings, store);
  await manager.loadBundles();
  await manager.scanAll();
  manager.rebuildIndexes();
  // No mif-cli: the bridge reports itself unavailable, as it does on a machine without one.
  const exec = (_file: string, _args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => cb(new Error("mif-cli is not installed"), "", "");
  const cli = new MifCli(v.app as never, manager, () => settings, exec as never, () => ({ path: "", home: "/nonexistent", windows: false, isExecutable: () => false }));
  const host = new VaultMcpHost(v.app as never, manager, cli, () => settings, pluginDir);
  const service = new McpService(host, () => settings, () => http, () => ({ startEndpoint }), "0.0.0-eval");
  const status = await service.sync();
  if (status.state !== "running") throw new Error(`The in-memory server did not start: ${JSON.stringify(status)}`);
  // As the plugin does: when the vault changes, tell listening clients. A short pause, since nothing here types.
  manager.on("changed", () => service.changed(150));

  const analyzed = async (path: string) => {
    const file = v.files.get(path);
    if (file) await manager.analyzeFile(file as never, { quiet: true });
    manager.rebuildIndexes();
    service.changed(150);
  };

  return {
    url: status.url,
    /** A note's text, or a dot-folder file's. */
    read: (path: string): string | undefined => v.texts.get(path) ?? dotFiles.get(path),
    paths: () => [...v.texts.keys()],
    trashed: () => [...v.trashed],
    notices: () => [...notices],
    auditLog: () => [...dotFiles].find(([k]) => k.endsWith("mcp-audit.log"))?.[1] ?? "",
    /** Change a note as the user would in Obsidian, saved. */
    async edit(path: string, change: (text: string) => string) {
      const file = v.files.get(path);
      if (!file) throw new Error(`No note at ${path}`);
      await v.app.vault.process(file, change);
      await analyzed(path);
    },
    async create(path: string, text: string) {
      await v.app.vault.create(path, text);
      await analyzed(path);
    },
    /** Open a note in an editor; with `unsaved`, the editor holds text that is not on disk yet. */
    openEditor(path: string, unsaved?: string, active = false) {
      const file = v.files.get(path);
      if (!file) throw new Error(`No note at ${path}`);
      const view = new MarkdownView(file, unsaved ?? v.texts.get(path) ?? "");
      v.app.workspace.views.push(view);
      if (active) v.app.workspace.active = view;
    },
    closeEditors() {
      v.app.workspace.views.length = 0;
      v.app.workspace.active = null;
    },
    /** Change the plugin's settings as the settings tab does, and let the service react. */
    async set(patch: Partial<MifSettings>) {
      Object.assign(settings, patch);
      await service.sync();
    },
    reviewQueue: () => host.reviewQueue().map((r) => r.path),
    promote: (path: string, level: Parameters<typeof host.promote>[1]) => host.promote(path, level),
    reject: (path: string) => host.reject(path),
    async close() {
      await service.dispose();
      manager.dispose();
    },
  };
}
