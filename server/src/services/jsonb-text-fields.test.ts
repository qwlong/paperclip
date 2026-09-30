import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jsonbTextFields } from "./jsonb-text-fields.js";

const dialect = new PgDialect();

describe("jsonbTextFields", () => {
  it("reads the column once and projects every key from that single read", () => {
    const query = dialect.sqlToQuery(
      jsonbTextFields(sql.raw("t.doc"), [{ key: "a" }, { key: "b", maxChars: 10 }]),
    );
    expect(query.sql.match(/t\.doc/g)).toHaveLength(1);
    expect(query.sql).toContain("t.doc || '{}'::jsonb AS c");
    expect(query.sql).toContain("OFFSET 0");
    expect(query.sql).toContain("'a', c ->> 'a'");
    expect(query.sql).toContain("'b', left(c ->> 'b', 10)");
  });

  it("rejects keys that are not plain identifiers", () => {
    expect(() => jsonbTextFields(sql.raw("t.doc"), [{ key: "a'); drop table x; --" }])).toThrow();
  });
});
