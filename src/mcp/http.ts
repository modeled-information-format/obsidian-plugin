// The MCP endpoint: a localhost-only HTTP listener in front of the SDK's
// per-request handler. No Obsidian import, and no Node import at load: the
// caller passes Node's `http` module in (the plugin gets it from
// `window.require` on desktop only; tests pass the real one).
//
// Host, Origin and the bearer token are checked on the raw Node request,
// before a web `Request` exists. The SDK's helpers read those headers from a
// `Request`, and a browser-engine `Request` (Obsidian's renderer is one)
// drops `Host` and `Origin` as forbidden header names, so they cannot be
// relied on here.

import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpHost } from "./host";
import { createServer } from "./tools";

// Types only; nothing is imported from Node when this module loads.
type Http = typeof import("node:http");
type IncomingMessage = import("node:http").IncomingMessage;
type ServerResponse = import("node:http").ServerResponse;
type Server = import("node:http").Server;

import { LOOPBACK, MAX_BODY, MCP_PATH, refusal } from "./guard";

export { LOOPBACK, MAX_BODY, MCP_PATH, newToken, refusal, sameToken, type Refusal } from "./guard";

function readBody(req: IncomingMessage): Promise<Uint8Array | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return resolve("too-large");
      const body = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        body.set(c, at);
        at += c.length;
      }
      resolve(body);
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  // A JSON-RPC error with no id, as the transport allows for a refused request.
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export interface McpEndpoint {
  port: number;
  url: string;
  /** Tell clients listening for list changes that the tools on offer have changed. */
  toolsChanged(): void;
  close(): Promise<void>;
}

export interface EndpointOptions {
  host: McpHost;
  port: number;
  /** Read on every request, so a regenerated token takes effect at once. */
  token: () => string;
  version: string;
  onError?: (error: Error) => void;
}

/**
 * Start the endpoint on 127.0.0.1. Rejects when the port cannot be bound
 * (for example EADDRINUSE); it never falls back to another port.
 */
export function startEndpoint(http: Http, opts: EndpointOptions): Promise<McpEndpoint> {
  const handler = createMcpHandler(() => createServer(opts.host, opts.version), { onerror: opts.onError });
  const server: Server = http.createServer((req, res) => {
    void serve(req, res).catch((err: unknown) => {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      if (!res.headersSent) send(res, 500, "Internal error.");
      else res.end();
    });
  });

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refused = refusal(req, opts.token());
    if (refused) {
      req.resume();
      return send(res, refused.status, refused.message, refused.headers);
    }
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    if (body === "too-large") return send(res, 413, `Request body over ${MAX_BODY} bytes.`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "authorization") continue;
      try {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      } catch {
        // A header the runtime's Request refuses to carry; MCP needs none of those.
      }
    }
    const request = new Request(`http://${LOOPBACK}:${opts.port}${MCP_PATH}`, { method, headers, ...(body && body.length ? { body: new TextDecoder().decode(body) } : {}) });
    const response = await handler.fetch(request);
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      out[name] = value;
    });
    res.writeHead(response.status, out);
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    // A client that goes away cancels its request (transport: closing the stream cancels).
    res.on("close", () => void reader.cancel().catch(() => undefined));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, LOOPBACK, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      opts.port = port;
      resolve({
        port,
        url: `http://${LOOPBACK}:${port}${MCP_PATH}`,
        toolsChanged: () => handler.notify.toolsChanged(),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
            void handler.close?.();
          }),
      });
    });
  });
}
