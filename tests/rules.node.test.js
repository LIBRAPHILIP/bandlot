import test from "node:test";
import assert from "node:assert/strict";
import { notionalWei, sourceUrl, unitCents, WEI_PER_EUR_CENT } from "../src/genlayer/rules.js";

const URL = "https://api.energy-charts.info/price?bzn=DE-LU&start=2026-11-12&end=2026-11-12";

test("source url is the contract-built energy-charts series", () => {
  assert.equal(sourceUrl("DE-LU", "2026-11-12"), URL);
});

test("floor division matches the python vectors", () => {
  assert.equal(unitCents(22490, 100), 22714n);
  assert.equal(unitCents(22490, 400), 23389n);
  assert.equal(unitCents(22490, -2000), 17992n);
  assert.equal(notionalWei(22490, 100, 1), 22714n * WEI_PER_EUR_CENT);
  assert.equal(notionalWei(22490, 400, 1), 23389n * WEI_PER_EUR_CENT);
});
