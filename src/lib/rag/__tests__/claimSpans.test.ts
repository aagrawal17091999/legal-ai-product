import { test } from "node:test";
import assert from "node:assert";
import { extractClaims } from "../faithfulness.ts";

// Shaped like the production answer that triggered the 77s rewrite: a case name
// containing "v.", bold, a bullet, and a Markdown summary table.
const DRAFT = [
  "## Similarly situated",
  "",
  "In *State of Punjab v. Joginder Singh* the majority held that two cadres may continue dissimilarly [^4]. The Court reiterated this in **Ram Lal Wadhwa** [^5].",
  "",
  "- Mere illness is not by itself sufficient cause for condonation of delay [^7].",
  "",
  "| Proposition | Position |",
  "|---|---|",
  '| "Similarly situated" turns on cadre structure | *Joginder Singh* [^4]; *Ram Lal Wadhwa* [^5] |',
].join("\n");

test("case names containing 'v.' are not split mid-citation", () => {
  const claims = extractClaims(DRAFT);
  for (const c of claims) console.log(`  claim: ${JSON.stringify(c.text)}`);
  assert.ok(
    !claims.some((c) => c.text.startsWith("Joginder Singh ")),
    "must not produce a fragment starting after 'v.'"
  );
});

test("every prose claim's span round-trips to the original draft", () => {
  const claims = extractClaims(DRAFT).filter((c) => c.start >= 0);
  assert.ok(claims.length >= 3, `expected >=3 spliceable claims, got ${claims.length}`);
  for (const c of claims) {
    const raw = DRAFT.slice(c.start, c.end);
    console.log(`  span -> ${JSON.stringify(raw)}`);
    assert.ok(raw.includes("[^"), "span must cover the citation marker");
    assert.ok(raw.trim() === raw, "span must not include surrounding whitespace");
  }
});

test("a table row is one claim, carrying its own citation, and is unspliceable", () => {
  const rows = extractClaims(DRAFT).filter((c) => c.start === -1);
  assert.equal(rows.length, 1, "the one data row should yield one claim");
  console.log(`  table claim: ${JSON.stringify(rows[0].text)}`);
  assert.deepEqual(rows[0].indices.sort(), [4, 5], "row keeps both citations");
  assert.ok(!/\|/.test(rows[0].text), "no leftover table pipes");
});

test("splicing a replacement by span rebuilds a coherent draft", () => {
  const c = extractClaims(DRAFT).filter((x) => x.start >= 0)[0];
  const patched = DRAFT.slice(0, c.start) + "REPLACED [^4]." + DRAFT.slice(c.end);
  console.log(`  patched line: ${patched.split("\n")[2]}`);
  assert.ok(patched.includes("REPLACED [^4]."));
  assert.ok(patched.includes("## Similarly situated"), "rest of draft intact");
  assert.ok(patched.includes("Ram Lal Wadhwa"), "sibling sentence untouched");
});
