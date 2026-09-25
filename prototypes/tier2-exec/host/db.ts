// PROTOTYPE for #311: the pg pool to Neon and the spike's schema. One database;
// companies are a column here (ADR-0009's database-per-company is lane B's).
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 60_000
});
pool.on("error", (e) => console.log(`[db] idle client error (Neon dropped it?): ${e.message}`));

export async function migrate() {
  await pool.query(`
    create table if not exists contacts (id bigserial primary key, company text not null, name text, email text, created_by text);
    create index if not exists contacts_company_name on contacts (company, name);
    create table if not exists counters (company text not null, name text not null, value int not null default 0, primary key (company, name));
    create table if not exists invocations (
      id text primary key, company text, patch text, version text, handler text, kind text,
      viewer text, as_mode text, principal text, attempts int, outcome text,
      started_at timestamptz, ended_at timestamptz, timing jsonb);
    create table if not exists operations (
      id bigserial primary key, invocation_id text, attempt int, op text, principal text, ms real, at timestamptz default now());
  `);
}

export async function reset(company: string) {
  await pool.query("delete from contacts where company = $1", [company]);
  await pool.query(
    "delete from operations where invocation_id in (select id from invocations where company = $1)",
    [company]
  );
  await pool.query("delete from invocations where company = $1", [company]);
  await pool.query(
    "insert into counters (company, name, value) values ($1, 'hits', 0) on conflict (company, name) do update set value = 0",
    [company]
  );
}

type Q = { query: pg.Pool["query"] };

// Table operations, company-scoped. `where` is an equality map; a key ending
// in `_like` becomes LIKE.
function whereClause(company: string, where: Record<string, unknown> = {}, offset = 1) {
  const parts = [`company = $${offset}`];
  const vals: unknown[] = [company];
  for (const [k, v] of Object.entries(where)) {
    vals.push(v);
    parts.push(
      k.endsWith("_like")
        ? `${k.slice(0, -5)} like $${offset + vals.length - 1}`
        : `${k} = $${offset + vals.length - 1}`
    );
  }
  return { sql: parts.join(" and "), vals };
}

export async function tableOp(q: Q, company: string, principal: string, op: string, args: any) {
  const table = args.table;
  if (!["contacts", "counters"].includes(table)) throw new Error(`unknown table ${table}`);
  if (op === "tables.list") {
    const w = whereClause(company, args.where);
    return (await q.query(`select * from ${table} where ${w.sql} order by 1`, w.vals)).rows;
  }
  if (op === "tables.insert") {
    const cols = Object.keys(args.row);
    const vals = Object.values(args.row);
    const extra = table === "contacts" ? ", created_by" : "";
    const extraVal = table === "contacts" ? `, $${cols.length + 2}` : "";
    const sql = `insert into ${table} (company, ${cols.join(", ")}${extra}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}${extraVal}) returning *`;
    return (await q.query(sql, [company, ...vals, ...(table === "contacts" ? [principal] : [])]))
      .rows[0];
  }
  if (op === "tables.update") {
    const setCols = Object.keys(args.set);
    const setVals = Object.values(args.set);
    const w = whereClause(company, args.where, setCols.length + 1);
    const sql = `update ${table} set ${setCols.map((c, i) => `${c} = $${i + 1}`).join(", ")} where ${w.sql} returning *`;
    return (await q.query(sql, [...setVals, ...w.vals])).rows;
  }
  throw new Error(`unknown op ${op}`);
}

// Open N connections up front so invocations never pay Neon's connect cost
// (DNS + TLS + auth) on the critical path.
export async function warm(n = 8) {
  const t0 = Date.now();
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  clients.forEach((c) => c.release());
  console.log(`[db] warmed ${n} connections in ${Date.now() - t0} ms`);
}
