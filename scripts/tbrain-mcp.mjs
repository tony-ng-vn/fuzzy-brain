import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createTbrainServer() {
  return new McpServer({ name: "tbrain", version: "0.0.0" });
}

export function tbrainRuntimeConfig() {
  return { allowCapture: false, allowedSourceIds: [] };
}
