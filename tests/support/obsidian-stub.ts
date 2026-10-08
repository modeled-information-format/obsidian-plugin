// Minimal stand-in for the `obsidian` module, enough to run MifManager under
// Vitest. Only what the manager touches is implemented.

// Plugin code uses window.setTimeout; in Node, window is the global object.
(globalThis as { window?: unknown }).window ??= globalThis;

export class Events {
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  on(name: string, fn: (...a: unknown[]) => void) {
    (this.handlers[name] ??= []).push(fn);
    return { name, fn };
  }
  offref() {}
  trigger(name: string, ...args: unknown[]) {
    for (const fn of this.handlers[name] ?? []) fn(...args);
  }
}

export class TAbstractFile {
  path = "";
}

export class TFile extends TAbstractFile {
  name = "";
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
  constructor(path: string) {
    super();
    this.setPath(path);
  }
  setPath(p: string) {
    this.path = p;
    this.name = p.split("/").pop()!;
    this.extension = p.split(".").pop()!;
    this.basename = this.name.replace(/\.md$/, "");
  }
}

export class TFolder extends TAbstractFile {}

export class MarkdownView {}

export class Vault {
  static recurseChildren() {}
}

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

/** An in-memory vault whose writes fire `modify` like Obsidian's. */
export function memoryApp(initial: Record<string, string>, config: Record<string, unknown> = {}) {
  const texts = new Map(Object.entries(initial));
  const files = new Map([...texts.keys()].map((p) => [p, new TFile(p)]));
  const modifyHandlers: Array<(f: TFile) => void> = [];
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === "md"),
      getFiles: () => [...files.values()],
      cachedRead: async (f: TFile) => texts.get(f.path)!,
      process: async (f: TFile, fn: (t: string) => string) => {
        const out = fn(texts.get(f.path)!);
        texts.set(f.path, out);
        modifyHandlers.forEach((h) => h(f));
        return out;
      },
      adapter: { exists: async () => false, read: async () => "" },
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getConfig: (key: string) => config[key],
    },
    fileManager: {},
    workspace: { iterateAllLeaves: () => {} },
  };
  const move = (from: string, to: string) => {
    const f = files.get(from)!;
    files.delete(from);
    f.setPath(to);
    files.set(to, f);
    texts.set(to, texts.get(from)!);
    texts.delete(from);
    return f;
  };
  /**
   * Obsidian's link updater: replaces `oldLink` with `newLink` at the offset
   * it had when `snapshot` was taken (stale if the file changed since), then
   * fires modify — the stale-offset corruption this guards against.
   */
  const staleReplace = (path: string, snapshot: string, oldLink: string, newLink: string) => {
    const at = snapshot.indexOf(oldLink);
    const now = texts.get(path)!;
    texts.set(path, now.slice(0, at) + newLink + now.slice(at + oldLink.length));
    modifyHandlers.forEach((h) => h(files.get(path)!));
  };
  return { app, texts, files, move, staleReplace, onModify: (h: (f: TFile) => void) => modifyHandlers.push(h) };
}

export const normalizePath = (p: string) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

/** Fake network for requestUrl: url → body (string). */
export const network = new Map<string, string>();
export async function requestUrl(req: { url: string } | string) {
  const url = typeof req === "string" ? req : req.url;
  const body = network.get(url);
  if (body === undefined) throw new Error(`404 ${url}`);
  const bytes = new TextEncoder().encode(body);
  return { status: 200, headers: {}, text: body, json: (() => { try { return JSON.parse(body); } catch { return undefined; } })(), arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** An in-memory adapter for dot-folder files (.mif/, plugin dirs). */
export function memoryAdapter(files: Map<string, string>) {
  const dirs = () => new Set([...files.keys()].flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  return {
    exists: async (p: string) => files.has(p) || dirs().has(p),
    read: async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p)!;
    },
    write: async (p: string, d: string) => void files.set(p, d),
    mkdir: async () => {},
    rmdir: async (p: string) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
    },
    list: async (p: string) => {
      const prefix = `${p}/`;
      const under = [...files.keys()].filter((k) => k.startsWith(prefix));
      return {
        files: under.filter((k) => !k.slice(prefix.length).includes("/")),
        folders: [...new Set(under.filter((k) => k.slice(prefix.length).includes("/")).map((k) => prefix + k.slice(prefix.length).split("/")[0]))],
      };
    },
  };
}
