# Two-Layer Nodes, Brain Safety, and the Talk Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every node a verbatim raw layer next to its readable layer, sandbox all destructive database work into a `brain_dev` schema, and give the companion a ratified talk log.

**Architecture:** One idempotent schema file gains the `raw` column (CHECK-gated, backfilled) and a `talks` table; `migrate.mjs` rehearses every migration on a `brain_dev` schema before touching the real tables. The write contract (`raw` required, `body` defaults to `raw`) flows through `lib/validation.ts`, the API routes, the add-node panel, and `scripts/brain.mjs`, which also gains `set-readable`, `add-talk`, and `dump` verbs -- and deliberately no delete, clear, or `set-raw` verbs. The ritual documents (AGENTS.md, writing-style.md, the brain-companion skill) are amended so every agent produces the two layers the same way.

**Tech Stack:** Next.js 16 (App Router), plain `pg` driver, `node --test` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-09-two-layer-nodes-design.md`

## Global Constraints

- Plain ASCII only in everything written: code, comments, commits, docs. No emoji, no em-dash, no ellipsis character, no curly quotes; use "--", "->", "...".
- Conventional Commits: `type(scope): description`, imperative, lowercase, no trailing period. Never mention agent or tool names, never add agent co-author lines.
- Comments explain WHY, not what; one line where possible.
- Long markdown files: one full sentence per physical line.
- The real brain is production: the `public` schema currently holds Tony's 5 real nodes and 3 real edges. Never run DELETE, TRUNCATE, DROP, or bulk UPDATE against `public`. All experimental or destructive SQL happens in the `brain_dev` schema only.
- Never insert real-looking content into the `public` schema during verification. Verify write verbs with `BRAIN_SCHEMA=brain_dev` (Task 5 adds that seam) or inside rolled-back transactions.
- `raw` is Tony's verbatim words: never trim it, never edit it, never expose an update path for it.
- The meaning rule: the readable layer describes and quotes; it never interprets. No text any agent invented as "meaning" is written anywhere.
- Run `npm test`, `npm run lint`, and `npx tsc --noEmit` before every commit that touches app code (`lib/`, `app/`, `components/`).
- Work happens on `main` in `/Users/minhthiennguyen/Desktop/fuzzy-brain` (this repo commits straight to main). Other agent sessions run in parallel: stage files explicitly by path for every commit, never `git add -A` or `git add .`.
- `lib/*.ts` stays erasable-syntax TypeScript so `node --test` loads it via type stripping.

---

### Task 1: Two-layer schema, talks table, and the brain_dev rehearsal

**Files:**
- Modify: `scripts/schema.sql`
- Modify: `scripts/migrate.mjs`
- Modify: `tests/db.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `public.nodes` gains `raw text not null` with CHECK constraint `nodes_raw_not_blank`; new table `talks(id uuid pk, recap text not null CHECK non-blank, created_at timestamptz)`; a `brain_dev` schema containing the same tables; `npm run db:migrate` applies schema to `brain_dev` first, then `public`, and re-grants to `brain_dev_role` if that role exists.

- [ ] **Step 1: Write the failing tests**

In `tests/db.test.mjs`, the existing inserts omit `raw`, which the new CHECK will reject, so this step both adds new subtests and updates the existing ones. Replace the two existing round-trip/rejection subtests and add three new subtests, so the full `test("database schema and constraints", ...)` block body becomes:

```js
test("database schema and constraints", async (t) => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await t.test("connection is healthy", async () => {
      const { rows } = await client.query("select 1 as ok");
      assert.equal(rows[0].ok, 1);
    });

    await t.test("nodes and edges round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into nodes (type, title, body, raw) values ('story', 'test a', 'body a', 'raw a') returning id, raw",
        );
        assert.equal(a.rows[0].raw, "raw a");
        const b = await client.query(
          "insert into nodes (type, title, body, raw) values ('lesson', 'test b', 'body b', 'raw b') returning id",
        );
        const edge = await client.query(
          "insert into edges (source, target, why) values ($1, $2, 'a taught b') returning why",
          [a.rows[0].id, b.rows[0].id],
        );
        assert.equal(edge.rows[0].why, "a taught b");
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("edge without a why sentence is rejected", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into nodes (type, title, raw) values ('story', 'test a', 'raw a') returning id",
        );
        const b = await client.query(
          "insert into nodes (type, title, raw) values ('story', 'test b', 'raw b') returning id",
        );
        await assert.rejects(
          client.query("insert into edges (source, target, why) values ($1, $2, '   ')", [
            a.rows[0].id,
            b.rows[0].id,
          ]),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("node with blank raw is rejected", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query("insert into nodes (type, title, raw) values ('story', 'test blank raw', '   ')"),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("talk recaps round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          "insert into talks (recap) values ('shared the trip story; connected it to the split; left the bravery question open') returning recap",
        );
        assert.match(rows[0].recap, /bravery question open/);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("talk with a blank recap is rejected", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query("insert into talks (recap) values ('   ')"),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `node --test tests/db.test.mjs`
Expected: FAIL. The round-trip subtests error with `column "raw" of relation "nodes" does not exist`; the talks subtests error with `relation "talks" does not exist`; the blank-raw subtest fails because the rejection message does not match `/check constraint/i`.

- [ ] **Step 3: Update `scripts/schema.sql`**

Replace the whole file with:

```sql
-- The whole brain: atoms of meaning, and human-decided connections between them.
create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

-- Two layers per node: raw is Tony's verbatim words, body is the readable layer.
-- raw is immutable by convention and by omission: no tool exposes an update path.
alter table nodes add column if not exists raw text not null default '';

-- Backfill for nodes created before the raw layer existed: the stored body is
-- the closest surviving version of the original words; title is the last resort.
update nodes set raw = body where length(trim(raw)) = 0 and length(trim(body)) > 0;
update nodes set raw = title where length(trim(raw)) = 0;

-- Same spirit as the why gate below: a node without its raw words is rejected.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'nodes'::regclass and conname = 'nodes_raw_not_blank'
  ) then
    alter table nodes add constraint nodes_raw_not_blank check (length(trim(raw)) > 0);
  end if;
end $$;

-- Every edge must carry a "why" sentence. A connection without a reason is noise.
create table if not exists edges (
  id uuid primary key default gen_random_uuid(),
  source uuid not null references nodes(id) on delete cascade,
  target uuid not null references nodes(id) on delete cascade,
  why text not null check (length(trim(why)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists edges_source_idx on edges (source);
create index if not exists edges_target_idx on edges (target);

-- The companion's memory: ratified recaps of talking sessions.
-- Talks are conversation records, not atoms of meaning; the views never render them.
create table if not exists talks (
  id uuid primary key default gen_random_uuid(),
  recap text not null check (length(trim(recap)) > 0),
  created_at timestamptz not null default now()
);
```

Notes for the implementer:
- `conrelid = 'nodes'::regclass` resolves through the current `search_path`, so the DO block works per-schema when Task 1's migrate change applies this file to both `brain_dev` and `public`.
- The `default ''` on `raw` stays: it makes the ALTER idempotent, and the CHECK (not the default) is the gate that forces callers to supply raw.

- [ ] **Step 4: Update `scripts/migrate.mjs` to rehearse on brain_dev first**

Replace the `try` block (currently `await client.query(readFileSync(...)); console.log("schema applied");`) with:

```js
try {
  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  // Rehearse every migration on the sandbox schema first, then apply for real.
  await client.query("create schema if not exists brain_dev");
  await client.query("set search_path to brain_dev");
  await client.query(schemaSql);
  await client.query("set search_path to public");
  await client.query(schemaSql);
  // Keep the restricted dev role usable after new tables appear, if it exists.
  const role = await client.query("select 1 from pg_roles where rolname = 'brain_dev_role'");
  if ((role.rowCount ?? 0) > 0) {
    await client.query("grant usage on schema brain_dev to brain_dev_role");
    await client.query(
      "grant select, insert, update, delete on all tables in schema brain_dev to brain_dev_role",
    );
  }
  console.log("schema applied to brain_dev (rehearsal) and public");
} finally {
  await client.end();
}
```

- [ ] **Step 5: Run the migration**

Run: `npm run db:migrate`
Expected output: `schema applied to brain_dev (rehearsal) and public`

- [ ] **Step 6: Verify the backfill on the real brain (read-only)**

Run:

```bash
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const blank = await c.query('select count(*)::int as n from nodes where length(trim(raw)) = 0');
  const equal = await c.query('select count(*)::int as n from nodes where raw = body');
  const total = await c.query('select count(*)::int as n from nodes');
  console.log('total:', total.rows[0].n, 'blank raw:', blank.rows[0].n, 'raw=body:', equal.rows[0].n);
  await c.end();
});
"
```

Expected: `total: 5 blank raw: 0 raw=body: 5` (5 may be higher if Tony added nodes meanwhile; blank raw must be 0).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/db.test.mjs`
Expected: PASS, all subtests.

- [ ] **Step 8: Run the migration a second time to prove idempotency**

Run: `npm run db:migrate`
Expected: same success line, no errors.

- [ ] **Step 9: Run the full suite and commit**

Run: `npm test` (expected: all pass; other test files are untouched so far)

```bash
git add scripts/schema.sql scripts/migrate.mjs tests/db.test.mjs
git commit -m "feat(data): add raw layer, talks table, and brain_dev rehearsal to migrations"
```

---

### Task 2: Tests and seeds run only in the brain_dev sandbox

**Files:**
- Modify: `tests/db.test.mjs`
- Modify: `scripts/seed-test.mjs`

**Interfaces:**
- Consumes: the `brain_dev` schema from Task 1.
- Produces: `tests/db.test.mjs` and `scripts/seed-test.mjs` connect via `process.env.DATABASE_URL_DEV || process.env.DATABASE_URL`, force `search_path` to `brain_dev`, and abort if `current_schema()` is not `brain_dev`. Task 3 relies on the `DATABASE_URL_DEV` fallback chain.

- [ ] **Step 1: Write the failing sandbox test**

In `tests/db.test.mjs`, change the connection setup at the top of the `test(...)` block:

```js
test("database schema and constraints", async (t) => {
  // Tests always run in the brain_dev sandbox so the real brain is untouchable,
  // on top of the per-test transactions that roll back.
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("set search_path to brain_dev");

  try {
    await t.test("the brain_dev sandbox exists", async () => {
      const { rows } = await client.query("select current_schema() as s");
      assert.equal(rows[0].s, "brain_dev", "run npm run db:migrate to create the sandbox schema");
    });

    await t.test("connection is healthy", async () => {
```

(The rest of the subtests stay exactly as Task 1 left them; they now run against `brain_dev` tables through the search_path.)

- [ ] **Step 2: Run the tests to verify they pass against the sandbox**

Run: `node --test tests/db.test.mjs`
Expected: PASS (Task 1 already created the sandbox; the new subtest proves the tests are inside it).
To see the guard fail for the right reason, run once with a bogus dev URL pointing at a database without the schema if available; otherwise trust the assertion message check: temporarily change `brain_dev` to `brain_dev_missing` in the `set search_path` line, run, expect the sandbox subtest to FAIL with "run npm run db:migrate", then revert.

- [ ] **Step 3: Rewrite `scripts/seed-test.mjs` to be sandbox-only**

Replace the connection and guard section (everything between `loadEnvLocal();` and the `try {`) with:

```js
// Seeds are visual-QA fixtures; they live only in the brain_dev sandbox.
const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
const client = new pg.Client({ connectionString });
await client.connect();
await client.query("set search_path to brain_dev");
const schemaCheck = await client.query("select current_schema() as s");
if (schemaCheck.rows[0].s !== "brain_dev") {
  console.error("seed-test refuses to run outside the brain_dev schema; run npm run db:migrate first");
  await client.end();
  process.exit(1);
}
```

Then update the node insert inside the seeding branch to satisfy the raw CHECK (the seed body doubles as its raw):

```js
    for (const [type, title, body] of specs) {
      const { rows } = await client.query(
        "insert into nodes (type, title, body, raw) values ($1, $2, $3, $3) returning id",
        [type, title, body],
      );
      ids.push(rows[0].id);
    }
```

Also update the file's header comment to say the seeds live in the brain_dev sandbox.

- [ ] **Step 4: Verify the seed round-trip in the sandbox, and that the real brain is untouched**

```bash
node scripts/seed-test.mjs           # expected: seeded 6 test nodes, 5 test edges
node scripts/seed-test.mjs --clean   # expected: deleted 6 test nodes (edges cascade)
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const { rows } = await c.query(\"select count(*)::int as n from public.nodes where title like '[test]%'\");
  console.log('test rows in the real brain:', rows[0].n);
  await c.end();
});
"
```

Expected final line: `test rows in the real brain: 0`

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` (expected: all pass)

```bash
git add tests/db.test.mjs scripts/seed-test.mjs
git commit -m "test(data): run tests and seeds against the brain_dev sandbox only"
```

---

### Task 3: Restricted brain_dev_role, if the database allows it

**Files:**
- Modify: `.env.example`
- Modify (conditionally): `.env.local` (append `DATABASE_URL_DEV`; never print or commit this file)

**Interfaces:**
- Consumes: the `DATABASE_URL_DEV || DATABASE_URL` fallback from Task 2; the re-grant block in `migrate.mjs` from Task 1.
- Produces: if role creation is permitted, a `brain_dev_role` login role that has zero privileges on `public` tables and full DML on `brain_dev`, wired in via `DATABASE_URL_DEV`.

- [ ] **Step 1: Check whether the role can create roles (read-only)**

```bash
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const { rows } = await c.query('select rolcreaterole from pg_roles where rolname = current_user');
  console.log('can create roles:', rows[0].rolcreaterole);
  await c.end();
});
"
```

- [ ] **Step 2 (only if `can create roles: true`): Create the restricted role and grant sandbox-only access**

```bash
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const crypto = require('node:crypto');
const pg = require('pg');
const password = crypto.randomBytes(24).toString('base64url');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  await c.query(\`create role brain_dev_role login password '\${password}'\`);
  await c.query('grant usage on schema brain_dev to brain_dev_role');
  await c.query('grant select, insert, update, delete on all tables in schema brain_dev to brain_dev_role');
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'brain_dev_role';
  url.password = password;
  console.log('DATABASE_URL_DEV=' + url.toString());
  await c.end();
});
"
```

Append the printed `DATABASE_URL_DEV=...` line to `.env.local` (edit the file directly; do not echo the URL anywhere else, and never commit `.env.local`).

- [ ] **Step 3 (only if the role was created): Verify hard denial on the real tables**

```bash
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_DEV });
c.connect().then(async () => {
  await c.query('set search_path to brain_dev');
  const ok = await c.query(\"insert into nodes (type, title, raw) values ('story', '[test] role probe', 'probe raw') returning id\");
  await c.query('delete from nodes where id = \$1', [ok.rows[0].id]);
  console.log('sandbox write: ok');
  try {
    await c.query('select count(*) from public.nodes');
    console.log('PROBLEM: role can read the real brain');
    process.exit(1);
  } catch (e) {
    console.log('real brain access denied as intended:', e.message);
  }
  await c.end();
});
"
```

Expected: `sandbox write: ok` then `real brain access denied as intended: permission denied for table nodes`.
If the new role cannot even connect (some managed poolers require dashboard-registered users), drop it with `drop role brain_dev_role`, remove the `.env.local` line, and fall back to Step 4's documentation-only path.

- [ ] **Step 4: Document the dev URL in `.env.example`**

Append to `.env.example`:

```
# Optional: restricted sandbox connection used by tests and seeds.
# Created by the two-layer-nodes build when the database allows role creation;
# without it, tests and seeds still force search_path to the brain_dev schema.
# DATABASE_URL_DEV=postgres://brain_dev_role:...@.../app
```

- [ ] **Step 5: Prove tests still pass through whichever path exists, then commit**

Run: `npm test` (expected: all pass, now via `DATABASE_URL_DEV` when it exists)

```bash
git add .env.example
git commit -m "feat(data): document the restricted brain_dev sandbox connection"
```

---

### Task 4: The raw contract through validation, API, types, and the add-node form

**Files:**
- Modify: `lib/validation.ts`
- Modify: `app/api/nodes/route.ts`
- Modify: `app/api/graph/route.ts`
- Modify: `components/types.ts`
- Modify: `components/AddNodePanel.tsx`
- Test: `tests/validation.test.mjs`

**Interfaces:**
- Consumes: the `raw` column and CHECK from Task 1.
- Produces: `NodeInput` becomes `{ type: string; title: string; body: string; raw: string; connections: ConnectionInput[] }`; `validateNodeInput` requires non-blank `raw` (never trims it) and defaults `body` to `raw`; `POST /api/nodes` accepts and returns `raw`; `GET /api/graph` returns `raw` on every node; `BrainNode` gains `raw: string`. Tasks 5 and 6 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

In `tests/validation.test.mjs`, update the existing fixtures to carry `raw` and add the new rules. Replace the whole file body below the imports with:

```js
test("accepts a minimal valid node", () => {
  const res = validateNodeInput({ type: "story", title: "First job", raw: "the raw words" });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.connections, []);
});

test("type is optional and defaults to empty", () => {
  const res = validateNodeInput({ title: "Untyped node", raw: "kept exactly" });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.type, "");
});

test("raw is required and blank raw is rejected", () => {
  const missing = validateNodeInput({ title: "No raw" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /raw/);
  const blank = validateNodeInput({ title: "Blank raw", raw: "   " });
  assert.equal(blank.ok, false);
});

test("raw is never trimmed or altered", () => {
  const res = validateNodeInput({ title: "x", raw: "  spaces and typos kepy  " });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.raw, "  spaces and typos kepy  ");
});

test("body defaults to raw when absent or blank", () => {
  const absent = validateNodeInput({ title: "x", raw: "the words" });
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.value.body, "the words");
  const blank = validateNodeInput({ title: "x", raw: "the words", body: "   " });
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.value.body, "the words");
  const given = validateNodeInput({ title: "x", raw: "the words", body: "a readable" });
  assert.equal(given.ok, true);
  if (given.ok) assert.equal(given.value.body, "a readable");
});

test("trims and accepts a node with connections", () => {
  const res = validateNodeInput({
    type: " lesson ",
    title: " Ship early ",
    raw: "r",
    body: "b",
    connections: [{ targetId: " abc ", why: " it follows " }],
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.type, "lesson");
    assert.equal(res.value.title, "Ship early");
    assert.deepEqual(res.value.connections, [{ targetId: "abc", why: "it follows" }]);
  }
});

test("rejects missing title", () => {
  assert.equal(validateNodeInput({ type: "story", title: "  ", raw: "r" }).ok, false);
  assert.equal(validateNodeInput(null).ok, false);
});

test("rejects a connection with a blank why", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    raw: "r",
    connections: [{ targetId: "abc", why: "   " }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /why/);
});

test("rejects a connection without a target", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    raw: "r",
    connections: [{ why: "because" }],
  });
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test tests/validation.test.mjs`
Expected: FAIL. The raw-required, raw-untouched, and body-defaults tests fail because `validateNodeInput` neither knows nor returns `raw`.

- [ ] **Step 3: Implement the contract in `lib/validation.ts`**

Replace the file with:

```ts
export type ConnectionInput = { targetId: string; why: string };
export type NodeInput = {
  type: string;
  title: string;
  body: string;
  raw: string;
  connections: ConnectionInput[];
};

type Result = { ok: true; value: NodeInput } | { ok: false; error: string };

// Shared by the API route and tests. The why rule lives here as well as in the
// database CHECK constraint: a connection without a reason is rejected early.
// Same for the raw rule: a node without its verbatim words is rejected early.
export function validateNodeInput(input: unknown): Result {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body must be a JSON object" };
  const r = input as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  // raw is Tony's verbatim words: validated for substance, never trimmed or altered.
  const raw = typeof r.raw === "string" ? r.raw : "";
  if (!title) return { ok: false, error: "title is required" };
  if (!raw.trim()) return { ok: false, error: "raw is required: the node's verbatim words" };
  // A deliberately written thought is its own readable; body falls back to raw.
  const body = typeof r.body === "string" && r.body.trim() ? r.body : raw;

  const rawConnections = Array.isArray(r.connections) ? r.connections : [];
  const connections: ConnectionInput[] = [];
  for (const c of rawConnections) {
    if (typeof c !== "object" || c === null) return { ok: false, error: "each connection must be an object" };
    const cc = c as Record<string, unknown>;
    const targetId = typeof cc.targetId === "string" ? cc.targetId.trim() : "";
    const why = typeof cc.why === "string" ? cc.why.trim() : "";
    if (!targetId) return { ok: false, error: "connection targetId is required" };
    if (!why) return { ok: false, error: "every connection needs a why sentence" };
    connections.push({ targetId, why });
  }
  return { ok: true, value: { type, title, body, raw, connections } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/validation.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Thread raw through the API routes and types**

In `app/api/nodes/route.ts`, the incoming-JSON variable is already named `raw`, which would collide with the destructured field; rename it to `payload` first:

```ts
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = validateNodeInput(payload);
```

Then change the destructure and the insert:

```ts
  const { type, title, body, raw, connections } = parsed.value;
```

```ts
    const { rows } = await client.query(
      "insert into nodes (type, title, body, raw) values ($1, $2, $3, $4) returning id, type, title, body, raw, created_at",
      [type, title, body, raw],
    );
```

In `app/api/graph/route.ts`, change the nodes select:

```ts
      pool.query("select id, type, title, body, raw, created_at from nodes order by created_at"),
```

In `components/types.ts`, add `raw` to `BrainNode`:

```ts
export type BrainNode = {
  id: string;
  type: string;
  title: string;
  body: string;
  raw: string;
  created_at: string;
  x?: number;
  y?: number;
};
```

- [ ] **Step 6: Send the typed text as raw from `components/AddNodePanel.tsx`**

The form's textarea is the thought exactly as Tony typed it, so it is the raw; the server defaults the readable to it. Rename the state and payload:

```tsx
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
```

```tsx
        body: JSON.stringify({ title, raw, connections }),
```

```tsx
      <label style={styles.label}>
        Story
        <textarea
          style={{ ...styles.input, minHeight: 110, resize: "vertical" }}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="The full story, as long as it needs to be"
        />
      </label>
```

- [ ] **Step 7: Verify the whole write path end to end in the sandbox**

Run the app checks first: `npm test && npm run lint && npx tsc --noEmit` (expected: all clean).
Then exercise the real route against the running dev server if it is up (check with `curl -s localhost:3010/api/health`); a POST with a `[test]` title is acceptable ONLY if immediately followed by asking Tony -- so instead verify the transaction shape in the sandbox with plain SQL:

```bash
node -e "
require('fs').readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
});
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_DEV || process.env.DATABASE_URL });
c.connect().then(async () => {
  await c.query('set search_path to brain_dev');
  await c.query('begin');
  const { rows } = await c.query(
    \"insert into nodes (type, title, body, raw) values ('', 'probe', 'readable text', 'raw text') returning body, raw\",
  );
  console.log('body:', rows[0].body, '| raw:', rows[0].raw);
  await c.query('rollback');
  await c.end();
});
"
```

Expected: `body: readable text | raw: raw text`

- [ ] **Step 8: Commit**

```bash
git add lib/validation.ts app/api/nodes/route.ts app/api/graph/route.ts components/types.ts components/AddNodePanel.tsx tests/validation.test.mjs
git commit -m "feat(api): require verbatim raw on node writes and default readable to it"
```

---

### Task 5: brain.mjs learns the two layers, the talk log, set-readable, and dump

**Files:**
- Modify: `scripts/brain.mjs`
- Test: `tests/brain.test.mjs`

**Interfaces:**
- Consumes: `nodes.raw` and `talks` from Task 1.
- Produces: exported `formatIndex(nodes, edges, latestTalk)` where `latestTalk` is `{recap, created_at} | null`; exported `formatShow(nodes)` printing `READABLE` and `RAW` labeled sections; commands `index`, `show <id...>`, `add-node` (stdin `{type,title,raw,body}`), `add-edge` (unchanged), `set-readable <id>` (stdin `{body}`), `add-talk` (stdin `{recap}`), `dump`; env `BRAIN_SCHEMA` selects the schema (default `public`) so write verbs can be verified in the sandbox. The brain-companion skill (Task 7) documents these exact commands.

- [ ] **Step 1: Write the failing tests**

Replace `tests/brain.test.mjs` with:

```js
// Unit tests for the brain companion tool's pure formatters.
// No database: these exercise how the whole-brain index and the full-text
// view render, which is what Claude reads at the start of a talking session.
import test from "node:test";
import assert from "node:assert/strict";
import { formatIndex, formatShow } from "../scripts/brain.mjs";

const nodes = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    type: "event",
    title: "Summer 2026 - Founder Split",
    body: "The split happened in June.\n\nIt still stings.",
    raw: "the split happend in june... it still stings",
    created_at: "2026-07-02T18:40:33.168Z",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    type: "quote",
    title: "Rejection is redirection",
    body: "A door closing is a hallway opening.",
    raw: "a door closing is a hallway opening",
    // A real Date, as Postgres returns it -- not an ISO string.
    created_at: new Date("2026-07-02T18:36:09.475Z"),
  },
];

const edges = [
  {
    source: "11111111-1111-1111-1111-111111111111",
    target: "22222222-2222-2222-2222-222222222222",
    why: "The split was the rejection that redirected him.",
    src_title: "Summer 2026 - Founder Split",
    tgt_title: "Rejection is redirection",
  },
];

test("formatIndex renders the whole brain compactly", () => {
  const out = formatIndex(nodes, edges, null);
  // Header carries the counts so the reader knows the shape at a glance.
  assert.match(out, /nodes=2/);
  assert.match(out, /edges=1/);
  // Every node shows date, type, title, and its full id (needed to act on it).
  assert.match(out, /2026-07-02\s+event\s+Summer 2026 - Founder Split/);
  assert.ok(out.includes("11111111-1111-1111-1111-111111111111"));
  // A Date-typed created_at must render as YYYY-MM-DD too, not "Thu Jul 02".
  assert.match(out, /2026-07-02\s+quote\s+Rejection is redirection/);
  // Edges read as title -> title, with the why sentence.
  assert.match(out, /Summer 2026 - Founder Split\s+->\s+Rejection is redirection/);
  assert.ok(out.includes("The split was the rejection that redirected him."));
  // The index is the gist only: neither layer's text belongs here.
  assert.ok(!out.includes("It still stings."));
  assert.ok(!out.includes("it still stings"));
});

test("formatIndex opens with the latest talk recap when one exists", () => {
  const out = formatIndex(nodes, edges, {
    recap: "shared the trip story; the bravery question stayed open",
    created_at: "2026-07-08T02:00:00.000Z",
  });
  assert.match(out, /LAST TALK\s+2026-07-08/);
  assert.ok(out.includes("the bravery question stayed open"));
  // Without a talk, the section is absent entirely.
  assert.ok(!formatIndex(nodes, edges, null).includes("LAST TALK"));
});

test("formatShow renders both layers, readable first", () => {
  const out = formatShow([nodes[0]]);
  assert.match(out, /Summer 2026 - Founder Split/);
  const readableAt = out.indexOf("READABLE");
  const rawAt = out.indexOf("RAW");
  assert.ok(readableAt !== -1 && rawAt !== -1 && readableAt < rawAt);
  // The whole readable, paragraph breaks and all, and the verbatim raw.
  assert.ok(out.includes("It still stings."));
  assert.ok(out.includes("the split happend in june... it still stings"));
});

test("formatIndex handles an empty brain without crashing", () => {
  const out = formatIndex([], [], null);
  assert.match(out, /nodes=0/);
  assert.match(out, /edges=0/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brain.test.mjs`
Expected: FAIL. `formatIndex` does not accept a third argument (LAST TALK test fails) and `formatShow` prints no READABLE/RAW labels.

- [ ] **Step 3: Rewrite `scripts/brain.mjs`**

Replace the file with:

```js
// The brain companion's read/write tool. One place so a talking session never
// hand-rolls SQL or env loading. Reads: `index` (the whole brain, gist only,
// plus the latest talk recap) and `show <id...>` (both layers of a node).
// Writes: `add-node`, `add-edge`, `set-readable <id>`, `add-talk`, each reading
// one JSON object from stdin so bodies and whys keep their newlines and quotes.
// `dump` prints the entire brain as JSON for a snapshot in Tony's own hands.
// Deliberately absent, as protection by omission: no set-raw, no delete verbs.
// The database CHECKs on raw, why, and recap are the final gates (AGENTS.md);
// this tool never works around them. BRAIN_SCHEMA=brain_dev targets the sandbox.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// Postgres hands back created_at as a Date; tests pass ISO strings. Both land
// on YYYY-MM-DD this way.
function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** Compact whole-brain view: the gist Claude holds the entire session. */
export function formatIndex(nodes, edges, latestTalk = null) {
  const lines = [`BRAIN INDEX  nodes=${nodes.length} edges=${edges.length}`, ""];
  if (latestTalk) {
    lines.push(`LAST TALK  ${isoDate(latestTalk.created_at)}`);
    for (const l of String(latestTalk.recap).split("\n")) lines.push(`  ${l}`);
    lines.push("");
  }
  lines.push("NODES");
  for (const n of nodes) {
    lines.push(`  ${isoDate(n.created_at)}  ${n.type || "(untyped)"}  ${n.title}`);
    lines.push(`    ${n.id}`);
  }
  lines.push("");
  lines.push("EDGES");
  for (const e of edges) {
    lines.push(`  ${e.src_title}  ->  ${e.tgt_title}`);
    lines.push(`    why  ${e.why}`);
    lines.push(`    ${e.source} -> ${e.target}`);
  }
  return lines.join("\n");
}

/** Both layers of specific nodes, readable first: the guide, then the truth. */
export function formatShow(nodes) {
  return nodes
    .map((n) => {
      const head = `[${n.type || "(untyped)"}] ${n.title}  (${isoDate(n.created_at)})\n${n.id}`;
      return `${head}\n\nREADABLE\n${n.body}\n\nRAW\n${n.raw}`;
    })
    .join("\n\n----\n\n");
}

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  loadEnvLocal();
  const [command, ...args] = process.argv.slice(2);
  const schema = process.env.BRAIN_SCHEMA || "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid BRAIN_SCHEMA: ${schema}`);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`set search_path to ${schema}`);
    const s = await client.query("select current_schema() as s");
    if (s.rows[0].s !== schema) throw new Error(`schema ${schema} is missing; run npm run db:migrate`);

    if (!command || command === "index") {
      const nodes = (
        await client.query("select id, type, title, created_at from nodes order by created_at asc")
      ).rows;
      const edges = (
        await client.query(
          `select e.source, e.target, e.why, s.title as src_title, t.title as tgt_title
           from edges e
           join nodes s on s.id = e.source
           join nodes t on t.id = e.target
           order by e.created_at asc`,
        )
      ).rows;
      const talk = (
        await client.query("select recap, created_at from talks order by created_at desc limit 1")
      ).rows[0] ?? null;
      console.log(formatIndex(nodes, edges, talk));
    } else if (command === "show") {
      if (args.length === 0) throw new Error("show needs at least one node id");
      const { rows } = await client.query(
        "select id, type, title, body, raw, created_at from nodes where id = any($1::uuid[])",
        [args],
      );
      console.log(formatShow(rows));
    } else if (command === "add-node") {
      const { type, title, raw, body } = JSON.parse(await readStdin());
      if (!title) throw new Error("a node needs a title");
      if (!raw || !raw.trim()) throw new Error("a node needs its raw: Tony's verbatim words");
      // A deliberately written thought is its own readable; body falls back to raw.
      const readable = body && body.trim() ? body : raw;
      const { rows } = await client.query(
        "insert into nodes (type, title, body, raw) values ($1, $2, $3, $4) returning id, type, title, created_at",
        [type ?? "", title, readable, raw],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-edge") {
      const { source, target, why } = JSON.parse(await readStdin());
      // No client-side why check: the CHECK constraint is the one true gate.
      const { rows } = await client.query(
        "insert into edges (source, target, why) values ($1, $2, $3) returning id, source, target, why",
        [source, target, why],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "set-readable") {
      const [id] = args;
      if (!id) throw new Error("set-readable needs a node id");
      const { body } = JSON.parse(await readStdin());
      if (!body || !body.trim()) throw new Error("set-readable needs a non-empty body: the ratified readable");
      // Only the readable layer is writable; raw has no update path anywhere.
      const { rows, rowCount } = await client.query(
        "update nodes set body = $2 where id = $1 returning id, title, body",
        [id, body],
      );
      if (rowCount === 0) throw new Error(`no node with id ${id}`);
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-talk") {
      const { recap } = JSON.parse(await readStdin());
      if (!recap || !recap.trim()) throw new Error("a talk needs a recap");
      const { rows } = await client.query(
        "insert into talks (recap) values ($1) returning id, recap, created_at",
        [recap],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "dump") {
      const nodes = (await client.query("select * from nodes order by created_at asc")).rows;
      const edges = (await client.query("select * from edges order by created_at asc")).rows;
      const talks = (await client.query("select * from talks order by created_at asc")).rows;
      console.log(JSON.stringify({ dumped_at: new Date().toISOString(), nodes, edges, talks }, null, 2));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await client.end();
  }
}

// Only touch the database when run directly; importing for tests must not.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brain.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Verify every verb live -- reads on the real brain, writes in the sandbox**

```bash
node scripts/brain.mjs index                            # real brain, read-only; expect the node list, no LAST TALK yet
node scripts/brain.mjs dump | head -20                  # real brain, read-only; expect JSON with nodes/edges/talks keys
BRAIN_SCHEMA=brain_dev node scripts/brain.mjs index     # sandbox; expect nodes=0 (or seeded counts)
echo '{"type":"","title":"[test] layers","raw":"raw wrds here","body":"Readable here."}' | BRAIN_SCHEMA=brain_dev node scripts/brain.mjs add-node
# expect JSON with an id; note it as $ID
BRAIN_SCHEMA=brain_dev node scripts/brain.mjs show $ID  # expect READABLE then RAW sections
echo '{"body":"A re-ratified readable."}' | BRAIN_SCHEMA=brain_dev node scripts/brain.mjs set-readable $ID
echo '{"recap":"[test] talked about layers; left nothing open"}' | BRAIN_SCHEMA=brain_dev node scripts/brain.mjs add-talk
BRAIN_SCHEMA=brain_dev node scripts/brain.mjs index     # expect LAST TALK block at the top
node scripts/seed-test.mjs --clean                      # clears the [test] node from the sandbox
```

Expected: each command prints what its comment says; the final clean removes the probe node (the probe talk row may stay in the sandbox; it is invisible to the app and harmless).

- [ ] **Step 6: Full suite and commit**

Run: `npm test && npm run lint && npx tsc --noEmit` (expected: all clean)

```bash
git add scripts/brain.mjs tests/brain.test.mjs
git commit -m "feat(tools): teach brain.mjs the two layers, talk log, set-readable, and dump"
```

---

### Task 6: The see-the-raw toggle in the node detail panel

**Files:**
- Modify: `components/NodeDetailPanel.tsx`

**Interfaces:**
- Consumes: `BrainNode.raw` from Task 4.
- Produces: a `see the raw` / `hide the raw` toggle under the readable body; no other visual change.

- [ ] **Step 1: Add the toggle**

In `components/NodeDetailPanel.tsx`, add the import and state:

```tsx
import { useState } from "react";
```

Inside the component, before `const connections = ...`:

```tsx
  const [showRaw, setShowRaw] = useState(false);
```

Directly after the `<p ...>{node.body}</p>` element, insert:

```tsx
      <button style={styles.rawToggle} onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? "hide the raw" : "see the raw"}
      </button>
      {showRaw && (
        <p style={styles.rawBlock}>{node.raw}</p>
      )}
```

Add to the `styles` object:

```tsx
  rawToggle: {
    alignSelf: "flex-start",
    padding: "3px 10px",
    fontSize: 11,
    letterSpacing: 1,
    color: "#9fb4d8",
    background: "transparent",
    border: "1px solid rgba(120,150,220,0.25)",
    borderRadius: 6,
    cursor: "pointer",
  },
  rawBlock: {
    fontSize: 12.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    opacity: 0.6,
    margin: "10px 0 0",
    paddingLeft: 10,
    borderLeft: "2px solid rgba(120,150,220,0.25)",
  },
```

- [ ] **Step 2: Verify in the app**

Run: `npm test && npm run lint && npx tsc --noEmit` (expected: all clean).
Then check the running dev server (usually `localhost:3010`; start with `npm run dev` if down), open the brain, click a node, and confirm: the readable shows as before, the `see the raw` button reveals the raw block (identical text for backfilled nodes), and clicking again hides it. Reduced-motion and both views (face and map) open the same shared panel, so one check covers both.

- [ ] **Step 3: Commit**

```bash
git add components/NodeDetailPanel.tsx
git commit -m "feat(ui): add a see-the-raw toggle to the node detail panel"
```

---

### Task 7: Amend the ritual -- AGENTS.md, writing-style.md, and the companion skill

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/writing-style.md`
- Modify: `.claude/skills/brain-companion/SKILL.md`

**Interfaces:**
- Consumes: the command names from Task 5 (`add-node` with `{type,title,raw,body}`, `set-readable <id>`, `add-talk`, `dump`) and the schema semantics from Task 1.
- Produces: the ritual every future session follows.

- [ ] **Step 1: Replace rule 7 in `AGENTS.md`**

Replace the current rule 7 text with:

```markdown
7. Every node carries two layers: raw (Tony's verbatim words, stored exactly as he gave them, no edits of any kind, not even typos) and body (the readable layer).
   When Tony gives a thought, save his words as raw untouched and draft the readable per docs/writing-style.md; show him both layers before saving; save only after he agrees.
   The readable describes and quotes; it never interprets.
   No meaning enters the brain unless Tony said it or approved it: ratified meaning lives in edge whys, in his raw words, and in readable lines he explicitly approved.
   raw is immutable forever; the readable may be re-ratified later via set-readable, only with Tony's approval.
   If Tony corrects a readable pass, log the correction as a new rule in docs/writing-style.md so it doesn't recur.
```

- [ ] **Step 2: Append rule 9 to `AGENTS.md`**

After rule 8, add:

```markdown
9. Never run destructive SQL (delete, truncate, drop, bulk update) against the real brain, which lives in the public schema.
   Destructive experiments, tests, and seeds live only in the brain_dev schema; npm run db:migrate rehearses every migration there before touching the real tables.
   Deleting real nodes happens only on Tony's explicit ask, per rule 5.
   scripts/brain.mjs deliberately has no delete, clear, or set-raw verbs; do not add them and do not work around their absence with raw SQL.
```

- [ ] **Step 3: Rewrite `docs/writing-style.md` as the readable pass**

Replace the file with:

```markdown
# Writing style: the readable pass

This file governs the readable layer (`body`) that sits next to Tony's verbatim raw layer on every node.
The structure pass retired on 2026-07-09 when the raw layer landed: raw is now stored exactly as Tony gave it, with zero edits, so legibility work moved entirely into the readable layer.
It is a living document: every time Tony corrects a readable pass, the correction gets logged here as a rule, so the next pass needs fewer corrections.

## The loop

1. Tony gives a raw thought, in conversation or pasted.
2. The raw is saved exactly as given: no typo fixes, no grammar fixes, no reordering, nothing.
3. The agent drafts the readable per the rules below and shows Tony both layers before anything is saved.
4. Tony reviews; only after his yes does the node get written (scripts/brain.mjs add-node, or POST /api/nodes).
5. If Tony corrects something, the agent adds a rule or counter-example to this file so the same mistake doesn't happen on the next node.

## The readable pass rules

Do:
- Write neutral narration that describes what the raw says: the moment, what happened, who was there.
- Quote Tony's phrases verbatim, typos included, wherever the weight of the thought is; his words carry the meaning, the narration only carries the reader to them.
- Keep it short; the readable is a way back into the thought, not a replacement for it.
- Use plain paragraphs.

Do not:
- Interpret: no summary of "what this really means", no lessons, no patterns, no meaning Tony did not state in the raw.
- Add meaning-bearing labels or conclusions the raw does not contain; when Tony and the agent arrive at a meaning together in conversation and he approves it, it may be added then, and only then.
- Mention or imply connections to other nodes inside the readable; connections live as edges with ratified whys and render live next to the readable, so baked-in mentions would go stale and bypass the ritual.
- Add stylistic flourishes Tony didn't use: no em dashes, no rhetorical framing, no "it's not just X, it's Y" constructions.
- Launder his register: slang, swearing, self-deprecation, and pacing ellipses inside quotes stay exactly as written.

A node Tony types deliberately (the in-app form) is its own readable: the readable equals the raw, unchanged, until he ever asks to re-ratify it.

## Corrections log

(Empty so far. Next entry: date, what was tried, what Tony corrected, the rule that follows from it.)
```

- [ ] **Step 4: Update `.claude/skills/brain-companion/SKILL.md`**

Apply these changes (the rest of the skill stays as is):

Replace step 4 ("Capture a keeper.") with:

```markdown
4. **Capture a keeper.**
   Save his words as the raw layer exactly as he gave them: no typo fixes, no edits of any kind.
   Draft the readable layer per docs/writing-style.md: describe the moment, quote his phrases verbatim where the weight is, never interpret.
   Show him both layers before saving. Save only after he says yes.
   If he corrects the readable, log the correction as a new rule in docs/writing-style.md so it never recurs.
   Done when the saved node carries his verbatim raw and a readable he approved.
```

Replace step 2's last sentence block ("Done when your first line names something real...") to add resurfacing and the recap thread:

```markdown
2. **Open with the thread.**
   The index opens with the last talk's recap; greet him from it and from what is in his brain: the thing he left sitting last time, a thread still open, then an invitation.
   Now and then, resurface one old node that deserves another look; serendipity inside a session he started, never a scheduled ping.
   Done when your first line names something real from his brain, not a generic hello.
```

In step 3 ("Talk, and listen for keepers."), append one sentence:

```markdown
   Keepers are not only heavy moments; the digital self also holds jokes, wins, and small textures.
```

Add a new step 7 after "Render when a cluster wants seeing":

```markdown
7. **Close with a recap.**
   When the session winds down, draft a short factual recap: what he shared, what got connected, what is still open.
   The meaning rule applies to recaps too: describe, never interpret.
   Show it to him; on his yes, save it with add-talk. The next session's greeting stands on it.
   Done when the recap is saved, or he declined it.
```

Replace the "## Writing" section's command list with:

```markdown
- New node: `node scripts/brain.mjs add-node < node.json`
  where node.json is `{"type": "...", "title": "...", "raw": "...", "body": "..."}` (type may be ""; raw is his verbatim words; body is the readable and defaults to raw when omitted).
- New edge: `node scripts/brain.mjs add-edge < edge.json`
  where edge.json is `{"source": "<id>", "target": "<id>", "why": "..."}`.
- Re-ratify a readable: `node scripts/brain.mjs set-readable <id> < body.json` where body.json is `{"body": "..."}`; only after Tony approves the new version.
- Save a ratified recap: `node scripts/brain.mjs add-talk < talk.json` where talk.json is `{"recap": "..."}`.
- Snapshot for Tony: `node scripts/brain.mjs dump > backup.json` when he asks for a copy.
- There is no set-raw and no delete; that absence is the protection, never work around it (AGENTS.md rule 9).
```

Also update the skill's "Continuity" section to:

```markdown
## Continuity

The talk log is the memory between sessions: the greeting stands on the latest ratified recap plus the index.
If a thread is still open when a session winds down, name it in the recap so next time it is already waiting for you.
```

- [ ] **Step 5: Read all three documents end to end for consistency, then commit**

Check: rule numbers stay sequential, every command name matches Task 5's implementation exactly (`add-node`, `add-edge`, `set-readable <id>`, `add-talk`, `dump`), and nothing still references the structure pass as current.

```bash
git add AGENTS.md docs/writing-style.md .claude/skills/brain-companion/SKILL.md
git commit -m "docs(ritual): amend the ritual for two layers, the meaning rule, and brain safety"
```

---

### Task 8: Changelog, version, and final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything above.
- Produces: the released version.

- [ ] **Step 1: Determine the next version**

Run: `grep -m1 "## v" CHANGELOG.md`
Parallel sessions also release; take the top entry's minor plus one (if the top is `## v0.5.0`, this release is `0.6.0`).

- [ ] **Step 2: Add the changelog entry**

Insert at the top of `CHANGELOG.md` (below the intro and first `---`), with the version from Step 1 and today's date; follow the repo's fixed category order (Face, Map, Data, API, Tools, UI, Docs):

```markdown
## v0.6.0

Jul 9, 2026

**Data**

- Every node now keeps two layers: your raw words exactly as you gave them (never edited, not even typos, and no tool can change them), and a readable layer that guides you back into the thought. Existing nodes carried their stored text over as their raw.
- Added a talks table: at the end of a talking session the companion drafts a short factual recap, you approve it, and the next session's greeting picks up exactly where you left off.
- Added a brain_dev sandbox schema: tests, seeds, and experiments run there and are locked out of the real brain, and every migration rehearses on the sandbox before touching your real nodes.

**API**

- Creating a node now requires the raw words and treats the readable as optional; a deliberately typed thought counts as its own readable.

**Tools**

- brain.mjs learned the two layers and new verbs: set-readable (re-ratify a readable), add-talk (save an approved recap), and dump (a full JSON snapshot of the brain in your own hands). It still has no delete, clear, or set-raw on purpose.
- The visual-QA seed script now refuses to run anywhere but the sandbox.

**UI**

- The node panel shows the readable first with a quiet "see the raw" toggle for the verbatim original.

**Docs**

- The ritual grew the meaning rule: the readable describes and quotes but never interprets; meaning enters the brain only through you. The structure pass retired in favor of the readable pass, and a new rule bans destructive SQL against the real brain.
```

- [ ] **Step 3: Bump `package.json`**

Set `"version"` to the same version as the changelog entry (expected `0.6.0`).

- [ ] **Step 4: Full verification**

```bash
npm test               # expected: all tests pass
npm run lint           # expected: clean
npx tsc --noEmit       # expected: clean
npm run db:migrate     # expected: idempotent success line, third run
node scripts/brain.mjs index   # expected: real brain renders, read-only
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "docs(changelog): release two-layer nodes, brain safety, and the talk log"
```

---

## Plan self-review notes

- Spec coverage: the meaning rule (Task 7 docs + Task 5 tool comments), two layers with backfill (Task 1), immutable raw by omission (Tasks 1, 5, 7), talks table and ratified recaps (Tasks 1, 5, 7), write paths (Task 4), brain.mjs verbs including dump and the BRAIN_SCHEMA sandbox seam (Task 5), dev sandbox and seed guard (Task 2), conditional restricted role (Task 3), destructive-SQL rule (Task 7), UI raw toggle (Task 6), read paths unchanged for face/map (verified: both use body only), versioning (Task 8). Out-of-scope items from the spec stay out.
- The spec's "tests run only against brain_dev" is satisfied by Task 2; Task 1's intermediate state (new tests on public inside rolled-back transactions) matches the repo's existing pattern and lasts one task.
- Type consistency: `raw: string` on `NodeInput` (Task 4) and `BrainNode` (Task 4) matches the column (Task 1), `formatShow` consumption (Task 5), and `node.raw` in the panel (Task 6). Command names in Task 7 match Task 5 exactly.
