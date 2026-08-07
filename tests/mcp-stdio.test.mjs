import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function stdioTransport(env = getDefaultEnvironment()) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "fuzzy-brain-mcp.mjs")],
    cwd: root,
    env,
    stderr: "pipe",
  });
}

test("MCP executable speaks stdio without contaminating JSON-RPC output", async () => {
  const client = new Client({ name: "fuzzy-brain-stdio-test", version: "1.0.0" });
  const transport = stdioTransport();
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["get_node", "list_reminders", "mark_complete", "recall", "remember"],
    );
  } finally {
    await client.close();
  }
});
