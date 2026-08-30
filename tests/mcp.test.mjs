import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createFuzzyBrainServer,
  explicitTypeFromRaw,
  isExplicitCompletionCommand,
  isExplicitRememberCommand,
} from "../scripts/fuzzy-brain-mcp.mjs";

test("MCP write authorization checks exact user language", () => {
  assert.equal(explicitTypeFromRaw("story", "this history should be saved"), "note");
  assert.equal(explicitTypeFromRaw("startup area", "add this in my startup area"), "startup area");
  assert.equal(isExplicitRememberCommand("This is an observation."), false);
  assert.equal(isExplicitRememberCommand("Please save this observation."), true);
  assert.equal(isExplicitCompletionCommand("The finished result looks good."), false);
  assert.equal(isExplicitCompletionCommand("I finished both, please mark them complete."), true);
});

async function connectedClient(services) {
  const server = createFuzzyBrainServer(services, { logError() {} });
  const client = new Client({ name: "fuzzy-brain-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

test("MCP exposes canonical recall, reminder, node, remember, and completion tools", async () => {
  const calls = [];
  const { client, close } = await connectedClient({
    recall: async (question) => ({ question, state: "missing", hits: [] }),
    listReminders: async (at) => ({ at, overdue: [], upcoming: [] }),
    getNode: async (id) => ({ id, title: "Node" }),
    remember: async (input) => {
      calls.push(["remember", input]);
      return { id: "node-1", ...input };
    },
    markComplete: async (input) => {
      calls.push(["markComplete", input]);
      return { completed: input.nodeIds };
    },
  });

  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["get_node", "list_reminders", "mark_complete", "recall", "remember"],
    );
    const rememberTool = listed.tools.find((tool) => tool.name === "remember");
    const completeTool = listed.tools.find((tool) => tool.name === "mark_complete");
    assert.deepEqual(Object.keys(rememberTool.inputSchema.properties).sort(), ["raw", "type"]);
    assert.deepEqual(Object.keys(completeTool.inputSchema.properties).sort(), ["node_ids", "raw"]);

    const recalled = await client.callTool({ name: "recall", arguments: { question: "who is Evren" } });
    assert.match(recalled.content[0].text, /"state": "missing"/);

    const remembered = await client.callTool({
      name: "remember",
      arguments: {
        raw: "remember this offer until Aug 5 2027",
      },
    });
    assert.match(remembered.content[0].text, /node-1/);

    const completed = await client.callTool({
      name: "mark_complete",
      arguments: {
        node_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
        raw: "i finished both please mark it.",
      },
    });
    assert.match(completed.content[0].text, /completed/);
    assert.equal(calls[0][0], "remember");
    assert.equal(calls[0][1].raw, "remember this offer until Aug 5 2027");
    assert.equal(calls[0][1].title, undefined);
    assert.equal(calls[1][0], "markComplete");
    assert.deepEqual(calls[1][1].nodeIds, [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  } finally {
    await close();
  }
});

test("MCP rejects a completion without Tony's verbatim authorization", async () => {
  const { client, close } = await connectedClient({
    recall: async () => ({}),
    listReminders: async () => ({}),
    getNode: async () => ({}),
    remember: async () => ({}),
    markComplete: async () => assert.fail("invalid input must not reach the write service"),
  });
  try {
    const result = await client.callTool({
      name: "mark_complete",
      arguments: {
        node_ids: ["11111111-1111-4111-8111-111111111111"],
        raw: "The finished result looks good.",
      },
    });
    assert.equal(result.isError, true);
  } finally {
    await close();
  }
});

test("MCP rejects a memory statement without an explicit save command", async () => {
  const { client, close } = await connectedClient({
    recall: async () => ({}),
    listReminders: async () => ({}),
    getNode: async () => ({}),
    remember: async () => assert.fail("invalid input must not reach the write service"),
    markComplete: async () => ({}),
  });
  try {
    const result = await client.callTool({
      name: "remember",
      arguments: { raw: "This is an observation about my startup." },
    });
    assert.equal(result.isError, true);
  } finally {
    await close();
  }
});

test("MCP never returns database or filesystem details from a failed service", async () => {
  const { client, close } = await connectedClient({
    recall: async () => {
      throw new Error("postgresql://tony:secret@example.invalid/brain at /Users/tony/private");
    },
    listReminders: async () => ({}),
    getNode: async () => ({}),
    remember: async () => ({}),
    markComplete: async () => ({}),
  });
  try {
    const result = await client.callTool({ name: "recall", arguments: { question: "private" } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /secret|Users|postgresql/i);
    assert.match(result.content[0].text, /failed/i);
  } finally {
    await close();
  }
});
