import { describe, expect, it } from "vitest";
import { createPositionSchema, patchTradeSchema } from "./trade.ts";

const dram = {
  strategy: "csp",
  underlying: "DRAM",
  openedOn: "2026-09-25",
  expiry: "2026-10-09",
  quantity: 10,
  adjusted: false,
  strike: "50",
  price: "1.85",
  fees: "6.50",
  tags: [],
};

describe("shared trade contracts", () => {
  it("accepts the T6 DRAM opening fill", () => {
    expect(createPositionSchema.parse(dram)).toEqual(dram);
  });
  it.each([
    { ...dram, source: "ibkr_upload" },
    { ...dram, expiry: "2026-09-25" },
    { ...dram, quantity: 0 },
    { ...dram, price: "1.08501" },
    { ...dram, fees: "-6.50" },
    { ...dram, openedOn: "2026-02-30" },
    { ...dram, openedOn: "0000-01-01" },
    { ...dram, quantity: 2147483647 },
    { ...dram, price: "50" },
    {
      ...dram,
      strategy: "cc",
      quantity: 10000,
      strike: "900000",
      price: "1000",
      cover: { kind: "held", basis: "1" },
    },
    { ...dram, strategy: "cc", quantity: 2147483647, cover: { kind: "held", basis: "55" } },
    { ...dram, strategy: "cc", quantity: 1000000, cover: { kind: "held", basis: "99999999" } },
  ])("rejects invalid or server-owned fields: %j", (body) => {
    expect(createPositionSchema.safeParse(body).success).toBe(false);
  });
  it("permits price/fee edits, not lifecycle changes or an empty patch", () => {
    expect(patchTradeSchema.parse({ price: "2.00", fees: "0.6527" })).toEqual({
      price: "2.00",
      fees: "0.6527",
    });
    expect(patchTradeSchema.safeParse({}).success).toBe(false);
    expect(patchTradeSchema.safeParse({ quantity: 5 }).success).toBe(false);
  });
});
