// Term statistics side tables (DESIGN.md 6.6).
//
// Its own module rather than a pair of exports on load.mjs: bench-load.mjs
// needs the reader at setup, and importing load.mjs would drag the embedding
// model and the whole corpus generator into the load client's process.

// Two small tables per schema, built once after the corpus is loaded:
//
//   lexeme_stats(lexeme, ndoc)         -- exact document frequency per lexeme
//   term_stats(term, lexemes, frag, ndoc)
//
// `lexeme_stats` replaces the 5%-TABLESAMPLE ts_stat that bench-load.mjs used
// to run at setup, so idf at the 1M/10M tiers stops being an estimate.
//
// `term_stats` is the piece the scale-path retrieval actually needs. It maps a
// SURFACE word (what a query contains) to the lexemes Postgres's 'english'
// parser produces for it, plus a ready-made tsquery fragment over those
// lexemes and the document frequency of the rarest one. Two things depend on
// having the surface form:
//
//   1. Rare-term anchoring picks the OR lane's terms by document frequency, so
//      the engine has to be able to look a query word up EXACTLY. Its own
//      stem() is a deliberate approximation (see engine.mjs) and disagrees with
//      Postgres's snowball stemmer often enough to make the lookup unreliable.
//      Storing the mapping removes the guess.
//   2. Spell correction matches a typo against real words with pg_trgm, and a
//      stemmed vocabulary would be matching against truncated forms.
//
// Why the fragment rather than just the lexeme: Postgres's parser splits some
// surface words into several lexemes -- a planted rare token like "fwz-0218"
// becomes 'fwz' & '-0218' -- so one query word is not one lexeme, and the
// correct query fragment for it is a conjunction. Storing the fragment keeps
// that fact in one place instead of re-deriving it in three.
//
// Cost, measured at 1M on 2026-08-24: the distinct-surface-word scan is 15 s
// and yields 1,734 words; ts_stat over the full table is the other half. Both
// scale linearly, so ~3 minutes at 10M -- a one-time post-load step.
// ---------------------------------------------------------------------------

export async function buildTermStats(client, tier) {
  const started = Date.now();
  const schema = tier.schema;
  const table = `${schema}.memories`;
  const isReal = tier.vector === 'real';
  // Must match the expression each lane searches, or df is a statistic about a
  // different document than the one being ranked.
  const ftsExpr = isReal ? 'fts' : "to_tsvector('english', body)";
  const textExpr = isReal
    ? "coalesce(title, '') || ' ' || coalesce(raw, '') || ' ' || coalesce(body, '')"
    : 'body';

  await client.query('set statement_timeout = 0');

  await client.query(`drop table if exists ${schema}.lexeme_stats`);
  await client.query(
    `create table ${schema}.lexeme_stats as
       select word as lexeme, ndoc::bigint as ndoc
       from ts_stat($$select ${ftsExpr} from ${table}$$)`,
  );
  await client.query(`alter table ${schema}.lexeme_stats add primary key (lexeme)`);

  await client.query(`drop table if exists ${schema}.term_stats`);
  // The hyphen is kept inside the token class on purpose: the planted rare
  // tokens look like "fwz-0218", and splitting on "-" would put a vocabulary
  // entry on each half while a query still arrives carrying the whole token.
  await client.query(
    `create table ${schema}.term_stats as
     with surface as (
       select distinct t as term
       from ${table} m, lateral unnest(regexp_split_to_array(lower(${textExpr}), '[^a-z0-9-]+')) t
       where t <> ''
     ),
     mapped as (
       select s.term, tsvector_to_array(to_tsvector('english', s.term)) as lexemes
       from surface s
     )
     select mp.term,
            mp.lexemes,
            (select string_agg(quote_literal(l), ' & ') from unnest(mp.lexemes) l) as frag,
            (select min(ls.ndoc)
               from unnest(mp.lexemes) l
               join ${schema}.lexeme_stats ls on ls.lexeme = l) as ndoc
     from mapped mp
     where cardinality(mp.lexemes) > 0`,
  );
  // A surface word whose lexemes never reach the indexed tsvector (stopwords
  // slip through as empty arrays, already filtered; the rest are parser edge
  // cases) has no usable frequency, and keeping it would let the anchor picker
  // treat it as the rarest term in the query.
  await client.query(`delete from ${schema}.term_stats where ndoc is null or frag is null`);
  await client.query(`alter table ${schema}.term_stats add primary key (term)`);
  await client.query(
    `create index term_stats_trgm on ${schema}.term_stats using gin (term gin_trgm_ops)`,
  );
  await client.query(`analyze ${schema}.lexeme_stats`);
  await client.query(`analyze ${schema}.term_stats`);

  const { rows } = await client.query(
    `select (select count(*) from ${schema}.lexeme_stats) as lexemes,
            (select count(*) from ${schema}.term_stats)   as terms,
            (select count(*) from ${table})               as docs,
            pg_total_relation_size('${schema}.term_stats')   as term_bytes,
            pg_total_relation_size('${schema}.lexeme_stats') as lexeme_bytes`,
  );
  return {
    schema,
    lexemes: Number(rows[0].lexemes),
    terms: Number(rows[0].terms),
    totalDocs: Number(rows[0].docs),
    bytes: Number(rows[0].term_bytes) + Number(rows[0].lexeme_bytes),
    ms: Date.now() - started,
  };
}

// Reads what buildTermStats wrote into the shape engine.mjs's EngineContext
// wants. `df` keeps the lexeme-keyed map parseQueryFeatures already used (so
// idf/oov scoring is unchanged in shape, only exact instead of sampled), and
// `terms` is the new surface-word map the scale path's anchor picker reads.
export async function loadTermStats(client, tier) {
  const schema = tier.schema;
  const { rows: check } = await client.query('select to_regclass($1) as reg', [`${schema}.term_stats`]);
  if (!check[0].reg) return null;

  const { rows: docRows } = await client.query(`select count(*)::bigint as n from ${schema}.memories`);
  const { rows: lexRows } = await client.query(`select lexeme, ndoc from ${schema}.lexeme_stats`);
  const { rows: termRows } = await client.query(`select term, lexemes, frag, ndoc from ${schema}.term_stats`);

  const df = new Map();
  for (const r of lexRows) df.set(r.lexeme, Number(r.ndoc));
  const terms = new Map();
  for (const r of termRows) {
    terms.set(r.term, { lexemes: r.lexemes, frag: r.frag, ndoc: Number(r.ndoc) });
  }
  return { totalDocs: Number(docRows[0].n), df, terms, sampled: false, samplePct: 100 };
}
