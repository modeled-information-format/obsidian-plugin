// Who may reach the MCP endpoint: localhost only, with this vault's token.
// Pure, and free of the MCP SDK, so the plugin's main bundle can use it (to
// make a token, to say why a request was refused) without carrying the
// server code, which is a separate file loaded on desktop only (plan M32).

export const MCP_PATH = "/mcp";
export const LOOPBACK = "127.0.0.1";
/** Request bodies over this many bytes are refused. */
export const MAX_BODY = 1_048_576;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The hostname of a Host header value or an Origin, lower-cased, without the port. */
function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Length-independent comparison, so a wrong token costs the same time wherever it differs. */
export function sameToken(given: string, expected: string): boolean {
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i % Math.max(given.length, 1)) || 0) ^ expected.charCodeAt(i);
  return diff === 0 && expected.length > 0;
}

/** A 256-bit token, hex. Uses Web Crypto, which desktop and mobile both have. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Refusal {
  status: number;
  message: string;
  headers?: Record<string, string>;
}

type HeaderBag = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Why a request is refused before it reaches MCP, or undefined to let it
 * through. Order: DNS-rebinding checks first (spec: an invalid Origin is
 * 403), then the path, then the token.
 */
export function refusal(req: { url?: string; headers: HeaderBag }, token: string): Refusal | undefined {
  const host = one(req.headers.host);
  const hostname = host === undefined ? undefined : hostnameOf(host);
  if (!hostname || !LOCAL_HOSTNAMES.has(hostname)) return { status: 403, message: "Forbidden: this server answers only on localhost." };
  const origin = one(req.headers.origin);
  if (origin !== undefined) {
    const from = hostnameOf(origin);
    if (!from || !LOCAL_HOSTNAMES.has(from)) return { status: 403, message: "Forbidden: requests from this origin are not allowed." };
  }
  if ((req.url ?? "").split("?")[0] !== MCP_PATH) return { status: 404, message: `Not found. The MCP endpoint is ${MCP_PATH}.` };
  const auth = one(req.headers.authorization) ?? "";
  const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? "";
  if (!sameToken(given, token)) {
    return { status: 401, message: "Unauthorized: send this vault's MCP token as a Bearer token.", headers: { "WWW-Authenticate": 'Bearer realm="mif-vault"' } };
  }
  return undefined;
}
