// End-to-end integration test for the agent-session ingester, against the
// brain_dev sandbox (rule 9: destructive experiments live only there --
// this test cleans up its own rows by test-scoped source label).
// Exercises the whole Phase 2 pipeline: archive fixture -> parser ->
// allowlist -> DB exclusions -> CLI verbs -> episodes + evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
loadEnvLocal();

// Unit tests for the allowlist gate: the wildcard is the ONE way to open it
// wide, and every fail-closed refusal stays a refusal. Import happens with
// the config env pointed at a scratch dir so no real config is ever read.
test("loadConfig and admits: wildcard opens, everything else stays fail-closed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "fuzzy-ingest-config-"));
  const configPath = join(home, "ingest.json");
  const savedEnv = process.env.FUZZY_BRAIN_INGEST_CONFIG;
  process.env.FUZZY_BRAIN_INGEST_CONFIG = configPath;
  const { loadConfig, admits } = await import(
    pathToFileURL(join(root, "scripts", "ingest-sessions.mjs"))
  );

  try {
    await t.test("the explicit wildcard admits any project slug or cwd", () => {
      writeFileSync(configPath, JSON.stringify({ allowlist: "*", settledHours: 24 }));
      const cfg = loadConfig();
      assert.equal(cfg.allowlist, "*");
      assert.ok(admits(cfg.allowlist, "-Users-tony-Desktop-fuzzy-brain"));
      assert.ok(admits(cfg.allowlist, "-Users-tony-Desktop-some-new-project"));
      assert.ok(admits(cfg.allowlist, ""));
    });

    await t.test("an array allowlist still admits by substring and refuses the rest", () => {
      writeFileSync(configPath, JSON.stringify({ allowlist: ["fuzzy-brain"] }));
      const cfg = loadConfig();
      assert.ok(admits(cfg.allowlist, "-Users-tony-Desktop-fuzzy-brain"));
      assert.ok(!admits(cfg.allowlist, "-Users-tony-Desktop-work-repo"));
    });

    await t.test("missing config still refuses", () => {
      process.env.FUZZY_BRAIN_INGEST_CONFIG = join(home, "does-not-exist.json");
      assert.throws(loadConfig, /no ingest config/);
      process.env.FUZZY_BRAIN_INGEST_CONFIG = configPath;
    });

    await t.test("missing allowlist still refuses", () => {
      writeFileSync(configPath, JSON.stringify({ settledHours: 24 }));
      assert.throws(loadConfig, /allowlist/);
    });

    await t.test("an empty array allowlist still refuses", () => {
      writeFileSync(configPath, JSON.stringify({ allowlist: [] }));
      assert.throws(loadConfig, /allowlist/);
    });

    await t.test("only the exact string '*' is a wildcard; other strings refuse", () => {
      writeFileSync(configPath, JSON.stringify({ allowlist: "fuzzy-brain" }));
      assert.throws(loadConfig, /allowlist/);
    });
  } finally {
    if (savedEnv === undefined) delete process.env.FUZZY_BRAIN_INGEST_CONFIG;
    else process.env.FUZZY_BRAIN_INGEST_CONFIG = savedEnv;
    rmSync(home, { recursive: true, force: true });
  }
});

const TEST_LABEL = "claude-code-ingest-test";
const CODEX_TEST_LABEL = "codex-ingest-test";
const SESSION_A = "11111111-aaaa-4aaa-8aaa-111111111111"; // allowlisted, has an SSN + real turns
const SESSION_B = "22222222-bbbb-4bbb-8bbb-222222222222"; // not allowlisted
const SESSION_C = "33333333-cccc-4ccc-8ccc-333333333333"; // allowlisted, mentions an excluded person
const CODEX_A = "44444444-dddd-4ddd-8ddd-444444444444"; // codex, fuzzy-brain cwd
const CODEX_B = "55555555-eeee-4eee-8eee-555555555555"; // codex, other cwd
const SESSION_D = "66666666-ffff-4fff-8fff-666666666666"; // allowlisted, one giant turn

function codexSession(sessionId, cwd, userText) {
  return [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-10T09:00:00.000Z",
      payload: { id: sessionId, cwd },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-10T09:01:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-10T09:02:00.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex reply" }] },
    }),
  ].join("\n");
}

function entry(type, content, extra = {}) {
  return JSON.stringify({
    type,
    timestamp: extra.ts ?? "2026-07-10T09:00:00.000Z",
    sessionId: extra.sessionId,
    cwd: extra.cwd,
    message: { role: type, content },
    ...extra.flags,
  });
}

function makeSession(sessionId, cwd, userTexts) {
  const lines = [];
  for (const t of userTexts) {
    lines.push(entry("user", t, { sessionId, cwd }));
    lines.push(entry("assistant", [{ type: "text", text: `reply to: ${t.slice(0, 20)}` }], { sessionId, cwd }));
  }
  return lines.join("\n");
}

test("ingest-sessions: archive fixtures flow into brain_dev with every guard enforced", async (t) => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const home = mkdtempSync(join(tmpdir(), "fuzzy-ingest-"));
  const archive = join(home, "session-archive", "claude-code");
  const projectsDir = join(home, "fake-projects"); // stands in for ~/.claude/projects

  const allowedSlug = "-Users-tony-Desktop-fuzzy-brain";
  const otherSlug = "-Users-tony-Desktop-work-repo";
  mkdirSync(join(archive, allowedSlug), { recursive: true });
  mkdirSync(join(archive, otherSlug), { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  writeFileSync(
    join(archive, allowedSlug, `${SESSION_A}.jsonl`),
    makeSession(SESSION_A, "/Users/tony/Desktop/fuzzy-brain", [
      "i want to remember this thought about the trip",
      "my ssn is 123-45-6789 do not keep that",
      "and one more clean thought",
    ]),
  );
  writeFileSync(
    join(archive, otherSlug, `${SESSION_B}.jsonl`),
    makeSession(SESSION_B, "/Users/tony/Desktop/work-repo", ["work stuff that stays out of the cloud"]),
  );
  writeFileSync(
    join(archive, allowedSlug, `${SESSION_C}.jsonl`),
    makeSession(SESSION_C, "/Users/tony/Desktop/fuzzy-brain", ["talked with Jane Doe about something private"]),
  );
  // A pasted-transcript-sized turn: the episode raw echoed back by
  // add-episode exceeds execFileSync's default 1MB maxBuffer (the exact
  // crash the first wildcard backfill hit on a real Granola paste).
  writeFileSync(
    join(archive, allowedSlug, `${SESSION_D}.jsonl`),
    makeSession(SESSION_D, "/Users/tony/Desktop/fuzzy-brain", [
      "here is the whole meeting transcript " + "so many words were said in that room ".repeat(35000),
    ]),
  );

  const codexDir = join(home, "codex-sessions", "2026", "07", "10");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, `rollout-2026-07-10T09-00-00-${CODEX_A}.jsonl`),
    codexSession(CODEX_A, "/Users/tony/Desktop/fuzzy-brain", "codex, help with the brain repo"),
  );
  writeFileSync(
    join(codexDir, `rollout-2026-07-10T09-30-00-${CODEX_B}.jsonl`),
    codexSession(CODEX_B, "/Users/tony/Desktop/work-repo", "codex, help with work stuff"),
  );

  const configPath = join(home, "ingest.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      allowlist: ["fuzzy-brain"],
      settledHours: 0,
      sourceKind: "claude_code_session",
      sourceLabel: TEST_LABEL,
      codexSourceLabel: CODEX_TEST_LABEL,
      archiveRoot: join(home, "session-archive"),
      liveProjectsDir: projectsDir,
      codexSessionsDir: join(home, "codex-sessions"),
    }),
  );

  const env = {
    ...process.env,
    BRAIN_SCHEMA: "brain_dev",
    FUZZY_BRAIN_INGEST_CONFIG: configPath,
  };

  const run = () =>
    execFileSync("node", [join(root, "scripts", "ingest-sessions.mjs")], { env, encoding: "utf8" });

  try {
    // Pre-seed the source with the person exclusion so enforcement is real.
    execFileSync("node", [join(root, "scripts", "brain.mjs"), "add-source"], {
      env,
      encoding: "utf8",
      input: JSON.stringify({
        kind: "claude_code_session",
        label: TEST_LABEL,
        exclusions: [{ kind: "person", value: "Jane Doe" }],
      }),
    });

    const firstRun = run();

    await t.test("allowlisted session ingested; non-allowlisted stayed out", async () => {
      const { rows } = await client.query(
        `select e.source_locator from brain_dev.episodes e
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1`,
        [TEST_LABEL],
      );
      const locators = rows.map((r) => r.source_locator);
      assert.ok(locators.includes(SESSION_A), "allowlisted session must be ingested");
      assert.ok(!locators.includes(SESSION_B), "non-allowlisted session must never reach the cloud DB");
    });

    await t.test("excluded-person session produced zero rows", async () => {
      const { rows } = await client.query(
        `select count(*)::int as n from brain_dev.episodes e
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1 and e.source_locator = $2`,
        [TEST_LABEL, SESSION_C],
      );
      assert.equal(rows[0].n, 0);
    });

    await t.test("turns became evidence spans with speakers and exact offsets", async () => {
      const { rows } = await client.query(
        `select v.quote, v.start_offset, v.end_offset, v.speaker, e.raw
         from brain_dev.evidence v
         join brain_dev.episodes e on e.id = v.episode_id
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1 and e.source_locator = $2
         order by v.start_offset`,
        [TEST_LABEL, SESSION_A],
      );
      assert.equal(rows.length, 6); // 3 user + 3 assistant turns
      assert.equal(rows[0].speaker, "tony");
      assert.equal(rows[1].speaker, "assistant");
      for (const r of rows) {
        assert.equal(r.raw.slice(r.start_offset, r.end_offset), r.quote, "offsets must bound the quote exactly");
      }
    });

    await t.test("a giant-turn session still ingests whole (no cli buffer crash)", async () => {
      const { rows } = await client.query(
        `select count(*)::int as n from brain_dev.episodes e
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1 and e.source_locator = $2`,
        [TEST_LABEL, SESSION_D],
      );
      assert.equal(rows[0].n, 1, "an episode raw over 1MB must not kill the pipeline");
    });

    await t.test("the SSN never reached the database, in raw or in any span", async () => {
      const { rows } = await client.query(
        `select e.raw, string_agg(v.quote, ' ') as quotes
         from brain_dev.episodes e
         join brain_dev.sources s on s.id = e.source_id
         left join brain_dev.evidence v on v.episode_id = e.id
         where s.label = $1 and e.source_locator = $2
         group by e.raw`,
        [TEST_LABEL, SESSION_A],
      );
      assert.equal(rows.length, 1);
      for (const r of rows) {
        assert.ok(!r.raw.includes("123-45-6789"));
        assert.ok(!(r.quotes ?? "").includes("123-45-6789"));
        assert.ok(r.raw.includes("[REDACTED:ssn_pattern]"), "the placeholder marks where the filter fired");
      }
    });

    await t.test("no machine-injected text landed as evidence", async () => {
      const { rows } = await client.query(
        `select count(*)::int as n from brain_dev.evidence v
         join brain_dev.episodes e on e.id = v.episode_id
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1 and (v.quote like '%system-reminder%' or v.quote like '%tool_result%')`,
        [TEST_LABEL],
      );
      assert.equal(rows[0].n, 0);
    });

    await t.test("re-running the ingester is idempotent", async () => {
      const before = await client.query(
        `select count(*)::int as n from brain_dev.evidence v
         join brain_dev.episodes e on e.id = v.episode_id
         join brain_dev.sources s on s.id = e.source_id where s.label = $1`,
        [TEST_LABEL],
      );
      run();
      const after = await client.query(
        `select count(*)::int as n from brain_dev.evidence v
         join brain_dev.episodes e on e.id = v.episode_id
         join brain_dev.sources s on s.id = e.source_id where s.label = $1`,
        [TEST_LABEL],
      );
      assert.equal(after.rows[0].n, before.rows[0].n);
    });

    await t.test("the ingest summary reports what was skipped, never silently", () => {
      assert.match(firstRun, /ingested/i);
      assert.match(firstRun, /allowlist/i);
      assert.match(firstRun, /excluded/i);
    });

    await t.test("codex sessions flow through the same pipeline, gated by cwd allowlist", async () => {
      const { rows } = await client.query(
        `select e.source_locator from brain_dev.episodes e
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1`,
        [CODEX_TEST_LABEL],
      );
      const locators = rows.map((r) => r.source_locator);
      assert.ok(locators.includes(CODEX_A), "fuzzy-brain-cwd codex session must be ingested");
      assert.ok(!locators.includes(CODEX_B), "other-cwd codex session must stay out");
      const spans = await client.query(
        `select v.speaker from brain_dev.evidence v
         join brain_dev.episodes e on e.id = v.episode_id
         join brain_dev.sources s on s.id = e.source_id
         where s.label = $1 order by v.start_offset`,
        [CODEX_TEST_LABEL],
      );
      assert.deepEqual(spans.rows.map((r) => r.speaker), ["tony", "assistant"]);
    });
  } finally {
    // brain_dev-only cleanup, restrict-ordered: evidence -> episodes -> source.
    for (const label of [TEST_LABEL, CODEX_TEST_LABEL]) {
      await client.query(
        `delete from brain_dev.evidence v using brain_dev.episodes e, brain_dev.sources s
         where v.episode_id = e.id and e.source_id = s.id and s.label = $1`,
        [label],
      );
      await client.query(
        `delete from brain_dev.episodes e using brain_dev.sources s
         where e.source_id = s.id and s.label = $1`,
        [label],
      );
      await client.query(`delete from brain_dev.sources where label = $1`, [label]);
    }
    await client.end();
    rmSync(home, { recursive: true, force: true });
  }
});

function loadEnvLocal() {
  try {
    const text = readFileSync(join(here, "..", ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env.local; rely on the environment
  }
}
