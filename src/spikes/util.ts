// Shared helpers for the spikes. Spikes run inside Obsidian, write a
// markdown report under SPIKE_ROOT, and never touch files outside it.

import { apiVersion, normalizePath, Platform, TFile, type App } from "obsidian";

import { RESERVED_FILENAMES } from "../engine";

export const SPIKE_ROOT = "_spike";

/** MIF concept files in the vault, excluding spike output and reserved names. */
export function conceptFiles(app: App): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((f) => !f.path.startsWith(`${SPIKE_ROOT}/`) && !RESERVED_FILENAMES.has(f.name))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!app.vault.getAbstractFileByPath(p)) await app.vault.createFolder(p);
  }
}

/** Create or overwrite a file inside the spike folder. */
export async function writeSpikeFile(app: App, path: string, data: string): Promise<TFile> {
  const full = normalizePath(`${SPIKE_ROOT}/${path}`);
  await ensureFolder(app, full.split("/").slice(0, -1).join("/"));
  const existing = app.vault.getAbstractFileByPath(full);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, data);
    return existing;
  }
  return app.vault.create(full, data);
}

/** Wait until the metadata cache has indexed `file` (or time out). */
export function waitForCache(app: App, file: TFile, timeoutMs = 5000): Promise<boolean> {
  if (app.metadataCache.getFileCache(file)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const ref = app.metadataCache.on("changed", (changed) => {
      if (changed.path === file.path) finish(true);
    });
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean) {
      app.metadataCache.offref(ref);
      window.clearTimeout(timer);
      resolve(ok);
    }
  });
}

const platformName = () =>
  [Platform.isMobile ? "mobile" : "desktop", Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other"].join(" / ");

export const reportHeader = (title: string) =>
  `# ${title}\n\n- Obsidian API: ${apiVersion}\n- Platform: ${platformName()}\n- Run at: ${new Date().toISOString()}\n`;

/** Escape a value for a markdown table cell. */
export const cell = (v: unknown) =>
  String(typeof v === "string" ? v : JSON.stringify(v)).replace(/\|/g, "\\|").replace(/\n/g, "⏎");
