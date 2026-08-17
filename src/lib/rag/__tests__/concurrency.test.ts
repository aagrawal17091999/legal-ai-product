/**
 * Tests for the semaphore that bounds retrieval's SQL fan-out.
 *
 * The bug this guards against: an unbounded Promise.all over (queries × lanes)
 * queued more statements than the pg pool had clients, so the stragglers blew
 * past connectionTimeoutMillis and failed the whole search with
 * "timeout exceeded when trying to connect".
 *
 *   npx tsx --test src/lib/rag/__tests__/concurrency.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, mapLimit } from "../../concurrency.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("never exceeds the permit count", async () => {
  const sem = new Semaphore(3);
  let inFlight = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, () =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      })
    )
  );

  assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
  assert.equal(inFlight, 0);
});

test("releases the permit when the task throws", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error("boom"); }), /boom/);
  // If the failed task leaked its permit this would hang rather than resolve.
  assert.equal(await sem.run(async () => "recovered"), "recovered");
});

test("runs every queued task", async () => {
  const sem = new Semaphore(2);
  const done: number[] = [];
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      sem.run(async () => {
        await tick(1);
        done.push(i);
      })
    )
  );
  assert.equal(done.length, 10, "a queued task was dropped");
});

test("mapLimit preserves input order regardless of completion order", async () => {
  // Later items finish first, so a naive push-on-complete would misorder.
  const out = await mapLimit([30, 20, 10, 1], 4, async (ms, i) => {
    await tick(ms);
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("mapLimit caps concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight--;
  });
  assert.equal(peak, 4);
});

test("mapLimit on an empty list does no work", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => "x"), []);
});
