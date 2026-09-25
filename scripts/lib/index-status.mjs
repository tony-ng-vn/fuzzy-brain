import { z } from "zod";
import { schemaTables } from "../brain.mjs";

export const indexScopeShape = {
  source_id: z.uuid().optional().describe("Inspect one source, excluding approved nodes."),
  receipt_id: z.uuid().optional().describe("Inspect one committed archive receipt. Cannot be combined with source_id."),
};
const scopeSchema = z.object(indexScopeShape).strict().refine(value => !(value.source_id && value.receipt_id));
const fail = code => Object.assign(new Error(`Index status ${code}.`), { code });

export function parseIndexScope(input = {}) {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) throw fail("invalid");
  return parsed.data;
}

export function parseIndexArgs(args) {
  const input = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2).replaceAll("-", "_"), value = args[i + 1];
    if (!["--source-id", "--receipt-id"].includes(args[i]) || key in input || !value) throw fail("invalid");
    input[key] = value;
  }
  return parseIndexScope(input);
}

export async function resolveIndexScope(client, schema, input = {}) {
  const scope = parseIndexScope(input);
  const tables = schemaTables(schema);
  if (scope.source_id) {
    const source = await client.query(`select id from ${tables.sources} where id=$1`, [scope.source_id]);
    if (!source.rows.length) throw fail("not_found");
  }
  if (scope.receipt_id) {
    const receipt = await client.query(`select episode_id from "${schema}".archive_records where id=$1`, [scope.receipt_id]);
    if (!receipt.rows.length) throw fail("not_found");
    return { scope, episodeId: receipt.rows[0].episode_id };
  }
  return { scope, episodeId: null };
}

export async function indexStatus(client, schema, input = {}) {
  const { scope, episodeId } = await resolveIndexScope(client, schema, input);
  const tables = schemaTables(schema);
  const selected = Boolean(scope.source_id || scope.receipt_id);
  const filter = episodeId ? " where v.episode_id=$1" : scope.source_id ? " where e.source_id=$1" : "";
  const params = selected ? [episodeId ?? scope.source_id] : [];
  const count = "count(*)::int as total, count(embedding)::int as indexed, count(*) filter (where embedding is null)::int as pending";
  // Read both counts in one statement so a concurrent sweep cannot split the snapshot.
  const result = await client.query(`select 'evidence' as layer, ${count}
    from ${tables.evidence} v join ${tables.episodes} e on e.id=v.episode_id${filter}
    ${selected ? "" : `union all select 'nodes', ${count} from ${tables.nodes}`}`, params);
  const counts = layer => {
    const row = result.rows.find(row => row.layer === layer);
    return row ? { total: row.total, indexed: row.indexed, pending: row.pending } : null;
  };
  const evidence = counts("evidence"), nodes = counts("nodes");
  const total = evidence.total + (nodes?.total ?? 0);
  const pending = evidence.pending + (nodes?.pending ?? 0);
  return {
    scope, evidence, nodes, text_search_available: total > 0,
    semantic_index: {
      state: !total ? "empty" : pending ? "pending" : "complete",
      note: "Stored vectors enable semantic matching but do not guarantee useful results. Exact source reads and text search do not require vectors.",
    },
  };
}
