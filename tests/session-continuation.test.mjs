import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { renderEpisode } from "../scripts/lib/session-parser.mjs";

const wrapper = "<observed_from_primary_session><outcome>synthetic machine message</outcome></observed_from_primary_session>";
const turn = (text, speaker = "tony", ts = null) => ({ text, speaker, ts });
function run(env, script, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [`scripts/${script}.mjs`, ...args], { env, encoding: "utf8", timeout: 30000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function transcript(platform, sessionId, turns) {
  if (platform === "claude") return turns.map(t => JSON.stringify({
    type: t.speaker === "tony" ? "user" : "assistant", sessionId, cwd: "/synthetic/fuzzy-brain", timestamp: t.ts,
    message: { content: [{ type: "text", text: t.text }] },
  })).join("\n");
  return [JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/synthetic/fuzzy-brain" } }), ...turns.map(t => JSON.stringify({
    type: "response_item", timestamp: t.ts, payload: { type: "message", role: t.speaker === "tony" ? "user" : "assistant",
      content: [{ type: t.speaker === "tony" ? "input_text" : "output_text", text: t.text }] },
  }))].join("\n");
}

for (const platform of ["claude", "codex"]) {
  test(`${platform} continuation recovers skipped messages from unchanged legacy sessions`, async t => {
    const db = await createTbrainTestDatabase();
    t.after(() => db.close());
    const dir = await mkdtemp(join(tmpdir(), "session-continuation-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const sessionId = randomUUID();
    const label = `synthetic-${randomUUID()}`;
    const claude = join(dir, "archive", "claude-code", "fuzzy-brain");
    const codex = join(dir, "codex");
    await mkdir(claude, { recursive: true });
    await mkdir(codex);
    const file = join(platform === "claude" ? claude : codex, `${sessionId}.jsonl`);
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ allowlist: ["fuzzy-brain"], settledHours: 0,
      sourceLabel: platform === "claude" ? label : `${label}-other`,
      codexSourceLabel: platform === "codex" ? label : `${label}-other`,
      archiveRoot: join(dir, "archive"), liveProjectsDir: join(dir, "no-live"), codexSessionsDir: codex }));
    const env = { ...process.env, DATABASE_URL: db.url, DATABASE_URL_DEV: db.url, BRAIN_SCHEMA: "brain_dev",
      FUZZY_BRAIN_INGEST_CONFIG: config, FUZZY_BRAIN_INGEST_LOCK: join(dir, "ingest.lock") };
    const command = async (verb, input, args = []) => JSON.parse(await run(env, "brain", [verb, ...args], input));
    const source = await command("add-source", { kind: platform === "claude" ? "claude_code_session" : "codex_session", label });
    const seed = async (locator, turns) => {
      const rendered = renderEpisode(turns);
      return command("add-episode", { source_id: source.id, source_locator: locator, raw: rendered.raw,
        evidence: rendered.spans.map(s => ({ quote: s.text, speaker: s.speaker, start_offset: s.start, end_offset: s.end, occurred_at: s.ts })) });
    };
    const old = [turn("earlier question"), turn("earlier answer", "assistant")];
    const missing = [turn("message skipped before a later capture"), turn("skipped response", "assistant")];
    const later = [turn("already captured later question"), turn("already captured later answer", "assistant")];
    const full = [old[0], turn(wrapper), old[1], turn(wrapper), ...missing, ...later];
    await writeFile(file, transcript(platform, sessionId, full));
    await utimes(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const original = await seed(sessionId, [old[0], turn(wrapper), old[1], turn(wrapper)]);
    await seed(`${sessionId}:turns:6`, later);

    const first = await run(env, "ingest-sessions");
    assert.match(first, /failed\s+0/);
    const quotes = async () => (await db.client.query("select v.quote from brain_dev.evidence v join brain_dev.episodes e on e.id=v.episode_id where e.source_id=$1", [source.id])).rows.map(row => row.quote);
    for (const item of [...old, ...missing, ...later]) {
      assert.equal((await quotes()).filter(text => text === item.text).length, 1, `one stored occurrence of ${item.text}`);
    }
    assert.equal((await db.client.query("select raw from brain_dev.episodes where id=$1", [original.id])).rows[0].raw, original.raw);
    const before = (await quotes()).length;
    await run(env, "ingest-sessions");
    assert.equal((await quotes()).length, before);

    await writeFile(file, transcript(platform, sessionId, [...full, turn("a fresh appended thought")]));
    await run(env, "ingest-sessions");
    assert.equal((await quotes()).filter(text => text === "a fresh appended thought").length, 1);
    assert.equal((await quotes()).length, before + 1);

    await t.test("exclusions still match text that the sensitive-pattern filter would redact", async () => {
      await command("set-exclusions", { exclusions: [{ kind: "topic", value: "123-45-6789" }] }, [source.id]);
      await writeFile(file, transcript(platform, sessionId, [...full, turn("a fresh appended thought"), turn("Excluded source context 123-45-6789")]));
      const result = await run(env, "ingest-sessions");
      assert.match(result, /excluded\s+1/);
      assert.equal((await quotes()).length, before + 1);
    });
  });
}
