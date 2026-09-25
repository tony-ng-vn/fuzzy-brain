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
    env: { ...env, TBRAIN_TRACE: "0" },
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
      ["get_node", "index_status", "list_reminders", "list_traces", "mark_complete", "read_evidence", "read_trace", "read_write_receipt", "recall", "remember", "report_outcome", "trace_status", "trace_summary"],
    );
  } finally {
    await client.close();
  }
});
