import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
loadEnvLocal();

function brain(args, input) {
  return JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "brain.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BRAIN_SCHEMA: "brain_dev" },
    input: input === undefined ? undefined : JSON.stringify(input),
  }));
}

test("temporal CLI appends a deadline and completion without rewriting the node", async () => {
  const marker = `temporal-cli-${process.pid}-${Date.now()}`;
  const raw = `finish ${marker} by Aug 5 2027`;
  const node = brain(["add-node"], {
    type: "goal",
    title: marker,
    raw,
    body: raw,
  });
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_DEV || process.env.DATABASE_URL });
  await client.connect();
  try {
    const reminders = brain(["list-reminders", "--at=2026-08-06T23:30:00Z"]);
    assert.ok(reminders.upcoming.some((row) => row.node_id === node.id));

    brain(["clear-deadline", node.id], {
      raw: "clear that deadline please",
    });
    const cleared = brain(["list-reminders", "--at=2026-08-06T23:30:00Z"]);
    assert.ok(!cleared.upcoming.some((row) => row.node_id === node.id));

    brain(["set-deadline", node.id], {
      due_at: "2027-08-06T06:59:59.999Z",
      raw: "set the deadline back to Aug 5 2027",
      origin: "explicit",
    });

    const result = brain(["mark-complete"], {
      node_ids: [node.id],
      raw: "i finished it please mark it.",
      occurred_at: "2026-08-06T23:08:16Z",
    });
    assert.deepEqual(result.completed.map((item) => item.id), [node.id]);

    const stored = await client.query(
      `select n.raw, n.body, ts.status, ts.due_at,
              array_agg(e.event_type order by e.created_at) as event_types
       from brain_dev.nodes n
       join brain_dev.node_temporal_state ts on ts.node_id = n.id
       join brain_dev.node_temporal_events e on e.node_id = n.id
       where n.id = $1
       group by n.id, ts.status, ts.due_at`,
      [node.id],
    );
    assert.equal(stored.rows[0].raw, raw);
    assert.equal(stored.rows[0].body, raw);
    assert.equal(stored.rows[0].status, "completed");
    assert.equal(stored.rows[0].due_at.toISOString(), "2027-08-06T06:59:59.999Z");
    assert.deepEqual(stored.rows[0].event_types, [
      "deadline_set",
      "deadline_cleared",
      "deadline_set",
      "completed",
    ]);

    const after = brain(["list-reminders", "--at=2026-08-06T23:30:00Z"]);
    assert.ok(!after.upcoming.some((row) => row.node_id === node.id));
  } finally {
    await client.query("delete from brain_dev.node_temporal_events where node_id = $1", [node.id]);
    await client.query("delete from brain_dev.nodes where id = $1", [node.id]);
    await client.end();
  }
});

function loadEnvLocal() {
  try {
    const text = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env.local; rely on the environment
  }
}
