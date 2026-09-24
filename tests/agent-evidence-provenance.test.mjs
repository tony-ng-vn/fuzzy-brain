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
    { source: 0, locator: "session-two", speaker: "constructor", role: "unknown", key: "session-two" },
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

test("recall separates a passage timestamp from the source date used for retrieval", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID();
  const marker = `dateline${randomUUID().replaceAll("-", "")}`;
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'codex_session',$2)", [source, source]);
  const cases = [
    { at: null, from: "2026-09-05T00:00:00.000Z", until: "2026-09-06T00:00:00.000Z", basis: "source_context" },
    { at: "2026-09-05T12:00:00.000Z", from: "2026-09-05T00:00:00.000Z", until: null, basis: "message" },
    { at: null, from: null, until: null, basis: "unknown" },
  ];
  for (const item of cases) {
    item.episode = randomUUID();
    item.id = randomUUID();
    await db.query("insert into brain_dev.episodes(id,source_id,raw,occurred_at,occurred_until) values($1,$2,$3,$4,$5)",
      [item.episode, source, marker, item.from, item.until]);
    await db.query("insert into brain_dev.evidence(id,episode_id,quote,speaker,start_offset,end_offset,occurred_at) values($1,$2,$3,'tony',0,$4,$5)",
      [item.id, item.episode, marker, marker.length, item.at]);
  }
  const options = { client: db, schema: "brain_dev", embedQuery: async () => null };
  const result = await recall(marker, options);
  for (const item of cases) {
    const hit = result.hits.find(hit => hit.provenance.evidence_id === item.id);
    assert.equal(hit.provenance.occurred_at?.toISOString() ?? null, item.at);
    assert.equal(hit.provenance.source_occurred_at?.toISOString() ?? null, item.from);
    assert.equal(hit.provenance.source_occurred_until?.toISOString() ?? null, item.until);
    assert.equal(hit.provenance.date_filter_basis, item.basis);
    const read = await readEvidence(db, "brain_dev", { id: item.id });
    assert.equal(read.evidence.at?.toISOString() ?? null, item.at);
    assert.equal(read.evidence.source.occurred_at?.toISOString() ?? null, item.from);
    assert.equal(read.evidence.source.occurred_until?.toISOString() ?? null, item.until);
  }
  const dated = await recall(`${marker} September 2026`, options);
  assert.deepEqual(dated.hits.map(hit => hit.provenance.evidence_id).sort(), cases.slice(0, 2).map(item => item.id).sort());
  const exactDates = await searchArchive(db, "brain_dev", { query: marker, from: "2026-09-01T00:00:00Z", until: "2026-10-01T00:00:00Z" });
  assert.deepEqual(exactDates.hits.map(hit => hit.id), [cases[1].id], "archive date filters still require a known message timestamp");
  assert.equal(exactDates.hits[0].source.occurred_at.toISOString(), cases[1].from);
});
