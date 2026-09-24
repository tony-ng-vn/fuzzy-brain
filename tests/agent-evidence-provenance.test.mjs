import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { readEvidence, searchArchive } from "../scripts/lib/tbrain-store.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

test("retrieval identifies conversation fragments consistently without inventing source roles", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const sources = [randomUUID(), randomUUID(), randomUUID()];
  const marker = `provenance${randomUUID().replaceAll("-", "")}`;
  for (const [i, source] of sources.entries()) {
    await db.query("insert into brain_dev.sources(id,kind,label) values($1,$2,$3)",
      [source, ["codex_session", "claude_code_session", "meeting"][i], source]);
  }
  const specs = [
    { source: 0, locator: "session-one", speaker: "tony", role: "user", key: "session-one" },
    { source: 0, locator: "session-one:turns:2", speaker: "assistant", role: "assistant", key: "session-one" },
    { source: 0, locator: `session-one:sync:${"a".repeat(64)}`, speaker: "tony", role: "user", key: "session-one" },
    { source: 1, locator: "session-one:turns:2", speaker: "tony", role: "user", key: "session-one" },
    { source: 0, locator: "session-one:turns:notes", speaker: "someone", role: "unknown", key: "session-one:turns:notes" },
    { source: 2, locator: "session-one:turns:2", speaker: "tony", role: "unknown", key: null },
    { source: 0, locator: null, speaker: "tony", role: "user", key: null },
    { source: 0, locator: "tbrain:unavailable", speaker: "tony", role: "unknown", key: null },
  ];
  for (const spec of specs) {
    spec.episode = randomUUID();
    spec.id = randomUUID();
    await db.query("insert into brain_dev.episodes(id,source_id,source_locator,raw) values($1,$2,$3,$4)",
      [spec.episode, sources[spec.source], spec.locator, marker]);
    await db.query("insert into brain_dev.evidence(id,episode_id,quote,speaker,start_offset,end_offset) values($1,$2,$3,$4,0,$5)",
      [spec.id, spec.episode, marker, spec.speaker, marker.length]);
    spec.group = spec.key ? `${sources[spec.source]}:${spec.key}` : spec.episode;
  }
  await t.test("recall groups one session across captures and keeps other sources distinct", async () => {
    const result = await recall(marker, { client: db, schema: "brain_dev", embedQuery: async () => null });
    assert.equal(result.hits.length, specs.length);
    for (const spec of specs) {
      const hit = result.hits.find(hit => hit.provenance.evidence_id === spec.id);
      assert.equal(hit.observation_group, spec.group);
      assert.equal(hit.provenance.source_id, sources[spec.source]);
      assert.equal(hit.role, spec.role);
      assert.equal(hit.fidelity, "unknown");
    }
  });
  await t.test("passage readback retains the same source group and conservative role", async () => {
    for (const spec of specs) {
      const result = await readEvidence(db, "brain_dev", { id: spec.id });
      assert.equal(result.evidence.observation_group, spec.group);
      assert.equal(result.evidence.role, spec.role);
      assert.equal(result.evidence.fidelity, "unknown");
      assert.equal(result.context_scope, "episode");
    }
  });
  await t.test("archive search groups legacy sessions and filters on verified roles", async () => {
    const result = await searchArchive(db, "brain_dev", { query: marker });
    for (const spec of specs) {
      const hit = result.hits.find(hit => hit.id === spec.id);
      assert.equal(hit.observation_group, spec.group);
      assert.equal(hit.role, spec.role);
    }
    const users = await searchArchive(db, "brain_dev", { query: marker, role: "user" });
    assert.deepEqual(users.hits.map(hit => hit.id).sort(), specs.filter(spec => spec.role === "user").map(spec => spec.id).sort());
  });
});
