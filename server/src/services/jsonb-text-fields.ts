import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export type JsonbTextField = { key: string; maxChars?: number };

const PLAIN_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Projects several text fields of a jsonb column into one jsonb object while
// reading the column once. Each `col ->> 'k'` on a TOASTed value detoasts the
// whole document again; binding `col || '{}'` once materializes it a single
// time (and is total over every JSON type, so `->>` keeps its semantics).
// `OFFSET 0` keeps the planner from inlining the subquery back into N reads.
export function jsonbTextFields(
  column: SQLWrapper,
  fields: readonly JsonbTextField[],
): SQL<Record<string, string | null> | null> {
  const pairs = fields.map(({ key, maxChars }) => {
    if (!PLAIN_KEY_RE.test(key)) {
      throw new Error(`jsonbTextFields: unsupported key ${JSON.stringify(key)}`);
    }
    const literal = sql.raw(`'${key}'`);
    return maxChars === undefined
      ? sql`${literal}, c ->> ${literal}`
      : sql`${literal}, left(c ->> ${literal}, ${sql.raw(String(Math.trunc(maxChars)))})`;
  });
  return sql<Record<string, string | null> | null>`(SELECT jsonb_build_object(${sql.join(pairs, sql`, `)}) FROM (SELECT ${column} || '{}'::jsonb AS c OFFSET 0) s)`;
}
