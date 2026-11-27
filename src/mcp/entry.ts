// The entry point of mcp.cjs: the MCP server code, built as its own file and
// loaded on desktop only, when a vault turns the server on (plan M32).
// main.js never imports this, so the MCP SDK is not in the bundle that every
// platform loads.

export { startEndpoint } from "./http";
