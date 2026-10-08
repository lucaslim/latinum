import { expect, test } from "vitest";
import type { Money4 } from "../domain/money.ts";
import { positionRevision } from "./positionRevision.ts";
import type * as s from "./schema.ts";

const position: typeof s.positions.$inferSelect = {
  id: "position",
  campaignId: "campaign",
  underlying: "MUU",
  strategy: "csp",
  role: "income",
  openedOn: "2026-09-01",
  closedOn: null,
  rollChainId: null,
  notes: null,
  tags: [],
};
const leg: typeof s.legs.$inferSelect = {
  id: "leg-a",
  positionId: position.id,
  kind: "put",
  side: "short",
  underlying: "MUU",
  strike: 250000 as Money4,
  expiry: "2026-10-16",
  multiplier: 100,
  adjusted: false,
  coveredLegId: null,
};
const trade: typeof s.trades.$inferSelect = {
  id: "trade-a",
  legId: leg.id,
  action: "open",
  tradeDate: "2026-09-01",
  quantity: 10,
  price: 15000 as Money4,
  cash: 15000000 as Money4,
  fees: -66000 as Money4,
  rollId: null,
  currency: "USD",
  source: "manual",
  executedAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

test("fixed raw-field tuples have a lowercase SHA-256 digest", () => {
  expect(positionRevision(position, [leg], [trade])).toBe(
    "a5633439036a254db16c999928bac3a56df8d3751e35aa5158dc50fdaa104e28",
  );
});

test("sorts independent copies of readonly inputs, regardless of row order", () => {
  const legs = Object.freeze([Object.freeze({ ...leg, id: "leg-b" }), Object.freeze(leg)]);
  const trades = Object.freeze([Object.freeze({ ...trade, id: "trade-b" }), Object.freeze(trade)]);
  const revision = positionRevision(position, legs, trades);
  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  expect(positionRevision(position, [...legs].reverse(), [...trades].reverse())).toBe(revision);
  expect(legs.map((row) => row.id)).toEqual(["leg-b", "leg-a"]);
  expect(trades.map((row) => row.id)).toEqual(["trade-b", "trade-a"]);
});

test("notes, tags, provenance and execution timestamps do not change the revision", () => {
  const revision = positionRevision(position, [leg], [trade]);
  expect(
    positionRevision(
      { ...position, notes: "annotation", tags: ["wheel"] },
      [leg],
      [
        {
          ...trade,
          source: "ibkr_upload",
          createdAt: new Date("2026-10-16T00:00:00Z"),
          executedAt: new Date("2026-09-01T15:00:00Z"),
        },
      ],
    ),
  ).toBe(revision);
});

test.each([
  { id: "other" },
  { campaignId: "other" },
  { underlying: "DRAM" },
  { strategy: "long_put" },
  { role: "hedge" },
  { openedOn: "2026-09-15" },
  { closedOn: "2026-10-16" },
  { rollChainId: "chain" },
] satisfies Partial<typeof position>[])(
  "position economic fields affect revision: %j",
  (change) => {
    expect(positionRevision({ ...position, ...change }, [leg], [trade])).not.toBe(
      positionRevision(position, [leg], [trade]),
    );
  },
);

test.each([
  { id: "other" },
  { kind: "call" },
  { side: "long" },
  { underlying: "DRAM" },
  { strike: 550000 as Money4 },
  { expiry: "2026-11-20" },
  { multiplier: 1 },
  { adjusted: true },
  { coveredLegId: "stock" },
] satisfies Partial<typeof leg>[])("leg economic fields affect revision: %j", (change) => {
  expect(positionRevision(position, [{ ...leg, ...change }], [trade])).not.toBe(
    positionRevision(position, [leg], [trade]),
  );
});

test.each([
  { id: "other" },
  { legId: "other" },
  { action: "close" },
  { tradeDate: "2026-10-16" },
  { quantity: 5 },
  { price: 4000 as Money4 },
  { cash: -2000000 as Money4 },
  { fees: -13000 as Money4 },
  { rollId: "roll" },
] satisfies Partial<typeof trade>[])("trade economic fields affect revision: %j", (change) => {
  expect(positionRevision(position, [leg], [{ ...trade, ...change }])).not.toBe(
    positionRevision(position, [leg], [trade]),
  );
});

test("adding or removing legs and trades affects the revision", () => {
  const revision = positionRevision(position, [leg], [trade]);
  expect(positionRevision(position, [], [trade])).not.toBe(revision);
  expect(positionRevision(position, [leg, { ...leg, id: "leg-b" }], [trade])).not.toBe(revision);
  expect(positionRevision(position, [leg], [])).not.toBe(revision);
  expect(positionRevision(position, [leg], [trade, { ...trade, id: "trade-b" }])).not.toBe(
    revision,
  );
});
