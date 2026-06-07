/**
 * Tests for the cases_cited parser used by the citation-graph tool (#3).
 *   node --experimental-strip-types --test src/lib/rag/__tests__/parseCitedCases.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCitedCases } from "../sessionStore.ts";

test("parses array of {name, citation} objects", () => {
  const r = parseCitedCases([
    { name: "Bhau Ram v. B. Baijnath Singh", citation: "1962 Supp. 724" },
    { name: "Fazle Rab v. Mohd. Yakeen", citation: "[2002] 1 S.C.R. 833" },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "Bhau Ram v. B. Baijnath Singh");
  assert.equal(r[0].citation, "1962 Supp. 724");
});

test("accepts bare strings as names with null citation", () => {
  const r = parseCitedCases(["Taylor v. Taylor"]);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "Taylor v. Taylor");
  assert.equal(r[0].citation, null);
});

test("dedupes identical entries", () => {
  const r = parseCitedCases([
    { name: "A v. B", citation: "1 SCC 1" },
    { name: "A v. B", citation: "1 SCC 1" },
  ]);
  assert.equal(r.length, 1);
});

test("skips empty entries and tolerates non-arrays", () => {
  assert.deepEqual(parseCitedCases(null), []);
  assert.deepEqual(parseCitedCases(undefined), []);
  assert.deepEqual(parseCitedCases("x"), []);
  assert.equal(parseCitedCases([{ name: "", citation: "" }, {}]).length, 0);
});
