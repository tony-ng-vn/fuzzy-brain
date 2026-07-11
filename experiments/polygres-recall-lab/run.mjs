import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildRecallPlan, classifyEpistemicState } from "./recall-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
loadEnvLocal();

const command = process.argv[2] ?? "status";
if (!new Set(["setup", "status", "compare"]).has(command)) {
  console.error("Usage: node experiments/polygres-recall-lab/run.mjs [setup|status|compare]");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL_DEV or DATABASE_URL is required.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  if (command === "setup") await setup();
  if (command === "status") await status();
  if (command === "compare") await compare();
} finally {
  await client.end();
}

async function setup() {
  await client.query("begin isolation level repeatable read");
  try {
    await assertSandboxAvailable();
    const publicBefore = await publicCounts();
    await client.query("set local search_path to brain_dev, public");
    await client.query(readFileSync(join(here, "schema.sql"), "utf8"));
    await client.query(readFileSync(join(here, "seed.sql"), "utf8"));
    const publicAfter = await publicCounts();
    if (JSON.stringify(publicBefore) !== JSON.stringify(publicAfter)) {
      throw new Error("public brain changed while setting up the isolated recall lab");
    }
    await client.query("commit");
    console.log("recall lab ready in brain_dev; public brain counts are unchanged");
    console.log(JSON.stringify({ publicBefore, publicAfter }, null, 2));
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function status() {
  await client.query("begin read only");
  try {
    const extensions = await client.query(
      "select extname, extversion from pg_extension where extname in ('graph', 'vector') order by extname",
    );
    const tableCheck = await client.query(
      "select to_regclass('brain_dev.recall_lab_claims') is not null as ready",
    );
    let lab = null;
    if (tableCheck.rows[0].ready) {
      lab = (
        await client.query(`
          select
            (select count(*)::int from brain_dev.recall_lab_episodes) as episodes,
            (select count(*)::int from brain_dev.recall_lab_entities) as entities,
            (select count(*)::int from brain_dev.recall_lab_claims) as claims,
            (select count(*)::int from brain_dev.recall_lab_search_documents) as search_documents,
            (select count(*)::int from brain_dev.recall_lab_resolution_paths) as resolution_paths
        `)
      ).rows[0];
    }
    console.log(JSON.stringify({ extensions: extensions.rows, lab }, null, 2));
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function compare() {
  await client.query("begin read only");
  try {
    const ready = await client.query(
      "select to_regclass('brain_dev.recall_lab_claims') is not null as ready",
    );
    if (!ready.rows[0].ready) throw new Error("run the recall lab setup command first");

    const text = await client.query(`
      select body, ts_rank(search_vector, websearch_to_tsquery('english', $1)) as score
      from brain_dev.recall_lab_search_documents
      where document_kind = 'sentence_only'
        and search_vector @@ websearch_to_tsquery('english', $1)
      order by score desc
      limit 3
    `, ["girlfriend Safford"]);

    const semantic = await client.query(`
      select id, document_kind, body, metadata,
             1 - (embedding <=> '[1,0,0,0,0,0,0,0]'::vector) as similarity
      from brain_dev.recall_lab_search_documents
      where embedding is not null
      order by embedding <=> '[1,0,0,0,0,0,0,0]'::vector
      limit 3
    `);

    const graph = await client.query(`
      with recursive walk as (
        select c.subject_entity_id as from_id,
               c.object_entity_id as to_id,
               c.predicate,
               1 as depth,
               array[c.subject_entity_id, c.object_entity_id] as entity_path,
               array[c.predicate] as relation_path
        from brain_dev.recall_lab_claims c
        where c.subject_entity_id = $1
          and c.object_entity_id is not null
          and c.status = 'ratified'
          and (c.valid_from is null or c.valid_from <= $2::timestamptz)
          and (c.valid_to is null or c.valid_to > $2::timestamptz)
        union all
        select w.to_id,
               c.object_entity_id,
               c.predicate,
               w.depth + 1,
               w.entity_path || c.object_entity_id,
               w.relation_path || c.predicate
        from walk w
        join brain_dev.recall_lab_claims c on c.subject_entity_id = w.to_id
        where w.depth < 4
          and c.object_entity_id is not null
          and c.status = 'ratified'
          and (c.valid_from is null or c.valid_from <= $2::timestamptz)
          and (c.valid_to is null or c.valid_to > $2::timestamptz)
          and not c.object_entity_id = any(w.entity_path)
      )
      select w.depth, w.relation_path,
             array(select e.canonical_name
                   from unnest(w.entity_path) with ordinality p(id, ord)
                   join brain_dev.recall_lab_entities e on e.id = p.id
                   order by p.ord) as entity_path
      from walk w
      order by w.depth, w.relation_path
    `, ["30000000-0000-4000-8000-000000000001", "2026-07-10T00:00:00Z"]);

    const claimRows = await client.query(`
      select lower(s.canonical_name) as subject,
             c.predicate,
             lower(o.canonical_name) as object,
             c.authority,
             c.valid_from as "validFrom",
             c.valid_to as "validTo"
      from brain_dev.recall_lab_claims c
      join brain_dev.recall_lab_entities s on s.id = c.subject_entity_id
      join brain_dev.recall_lab_entities o on o.id = c.object_entity_id
      where s.canonical_name = 'Doan' and c.predicate = 'lives_in'
    `);
    const paths = await client.query(`
      select source_kind as source, authorized
      from brain_dev.recall_lab_resolution_paths
      where subject_entity_id = $1 and predicate = 'exact_address'
      order by priority
    `, ["30000000-0000-4000-8000-000000000002"]);

    const current = classifyEpistemicState({
      asOf: "2026-07-10T00:00:00Z",
      claims: claimRows.rows,
      retrieval: { completed: true, indexHealthy: true },
      resolutionPaths: [],
    });
    const missing = classifyEpistemicState({
      asOf: "2026-07-10T00:00:00Z",
      claims: [],
      retrieval: { completed: true, indexHealthy: true },
      resolutionPaths: paths.rows,
    });
    const conflicting = classifyEpistemicState({
      asOf: "2026-07-10T00:00:00Z",
      claims: [
        ...claimRows.rows,
        {
          subject: "doan",
          predicate: "lives_in",
          object: "phoenix",
          authority: "tony_ratified",
          validFrom: "2026-06-01T00:00:00Z",
          validTo: null,
        },
      ],
      retrieval: { completed: true, indexHealthy: true },
      resolutionPaths: [],
    });

    console.log(JSON.stringify({
      note: "Fixture vectors are deterministic plumbing probes, not production embeddings.",
      plans: {
        unknownAnchor: buildRecallPlan({ hasKnownAnchor: false, maxSteps: 8 }),
        knownAnchor: buildRecallPlan({ hasKnownAnchor: true, maxSteps: 5 }),
      },
      sentenceOnly: text.rows,
      semanticSeed: semantic.rows,
      typedClaimTraversal: graph.rows,
      epistemicStates: { current, missing, conflicting },
    }, null, 2));
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function assertSandboxAvailable() {
  const schema = await client.query("select 1 from pg_namespace where nspname = 'brain_dev'");
  if (schema.rowCount !== 1) throw new Error("brain_dev is required; this lab refuses public fallback");
  const vector = await client.query("select 1 from pg_extension where extname = 'vector'");
  if (vector.rowCount !== 1) throw new Error("the installed vector extension is required");
}

async function publicCounts() {
  return (
    await client.query(`
      select
        (select count(*)::int from public.nodes) as nodes,
        (select count(*)::int from public.edges) as edges,
        (select count(*)::int from public.talks) as talks
    `)
  ).rows[0];
}

function loadEnvLocal() {
  try {
    const text = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // No local env file; rely on the process environment.
  }
}

