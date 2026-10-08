export type SyncMode = "observe" | "sync";

export interface MifSettings {
  /** Observe validates and fixes on request; Sync also stamps `modified` on save. */
  mode: SyncMode;
  /** Vault-relative bundle roots; "" is the vault root. Longest match wins. */
  bundleRoots: string[];
  /** Vault-relative folders never treated as MIF, even inside a bundle. */
  excludedFolders: string[];
  showDevCommands: boolean;
}

export const DEFAULT_SETTINGS: MifSettings = {
  mode: "observe",
  bundleRoots: [""],
  excludedFolders: ["_spike", "templates"],
  showDevCommands: false,
};

const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

/** Load saved data, migrating the earlier single `bundleRoot` setting. */
export function loadSettings(data: unknown): MifSettings {
  const saved = (data ?? {}) as Partial<MifSettings> & { bundleRoot?: string };
  const settings: MifSettings = { ...DEFAULT_SETTINGS, ...saved };
  if (saved.bundleRoots === undefined && typeof saved.bundleRoot === "string") {
    settings.bundleRoots = [clean(saved.bundleRoot)];
  }
  settings.bundleRoots = [...new Set(settings.bundleRoots.map(clean))];
  if (settings.bundleRoots.length === 0) settings.bundleRoots = [""];
  settings.excludedFolders = settings.excludedFolders.map(clean).filter(Boolean);
  delete (settings as { bundleRoot?: string }).bundleRoot;
  return settings;
}

export const parseLines = (text: string) => text.split("\n").map(clean);
