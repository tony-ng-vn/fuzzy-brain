import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { parseClaudeSessionTurns, parseCodexSessionTurns } from "../scripts/lib/session-parser.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const wrapper = "Hello memory agent, you are continuing to observe the primary Claude session.\n\n<observed_from_primary_session>\n<what_happened>Tool</what_happened><outcome>machine text</outcome>\n</observed_from_primary_session>";

test("session parsers do not attribute machine observer envelopes to the human", () => {
  for (const parse of [parseClaudeSessionTurns, parseCodexSessionTurns]) {
    const messages = [wrapper, "<observed_from_primary_session><outcome>machine</outcome></observed_from_primary_session>", "Please explain the observed_from_primary_session tag."];
    const entries = messages.map(text => parse === parseClaudeSessionTurns
      ? { type: "user", message: { content: text } }
      : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const parsed = parse(entries.map(JSON.stringify).join("\n"));
    assert.deepEqual(parsed.turns.map(turn => turn.text), [messages[2]]);
  }
});

test("conversational recall excludes legacy observer noise before candidate limits", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID(), episode = randomUUID(), evidence = randomUUID();
  const marker = `observer${randomUUID().replaceAll("-", "")}`;
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'claude_code_session',$2)", [source, source]);
  await db.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'synthetic session')", [episode, source]);
  for (let i = 0; i < 30; i++) {
    const text = wrapper.replace("machine text", marker);
    await db.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset,speaker) values($1,$2,$3,$4,'tony')", [episode, text, i * 1000, i * 1000 + text.length]);
  }
  const words = `I prefer ${marker} for my personal notes.`;
  await db.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker) values($1,$2,$3,40000,$4,'tony')", [evidence, episode, words, 40000 + words.length]);
  const result = await recall(marker, { client: db, schema: "brain_dev", embedQuery: async () => null });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].provenance.evidence_id, evidence);
  assert.equal(result.hits[0].quote, words);
  assert.equal((await db.query("select count(*)::int n from brain_dev.evidence")).rows[0].n, 31, "retrieval must not rewrite history");
});

test("failed retrieval lanes cannot report an empty memory as a successful search", async () => {
  const client = { async query(sql) {
    if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: [{ term: "brokenprobe", df: 1, total: 10 }] };
    if (/set_config/.test(sql)) return { rows: [] };
    throw new Error("postgresql://secret@private-host broken query");
  } };
  await assert.rejects(recall("brokenprobe", { client, schema: "brain_dev", embedQuery: async () => null }), error => {
    assert.equal(error.code, "unavailable");
    assert.doesNotMatch(error.message, /secret|private-host/);
    return true;
  });
});

test("degraded recall explains the missing capability without leaking model errors", async () => {
  const client = { async query(sql) {
    if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: [{ term: "safefailureprobe", df: 1, total: 10 }] };
    return { rows: [] };
  } };
  const result = await recall("safefailureprobe", { client, schema: "brain_dev", embedQuery: async () => { throw new Error("private /Users/name/token-secret"); } });
  assert.equal(result.degraded, true);
  assert.equal(result.exhaustive, false);
  assert.match(result.note, /vector lane unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /token-secret|Users/);
});
