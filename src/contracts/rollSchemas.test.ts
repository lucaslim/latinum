import { expect, test } from "vitest";
import { parseIsoDate } from "../domain/dates.ts";
import { rollSchema } from "./rollSchemas.ts";

const today = parseIsoDate("2026-10-01");
const raw = {
  positionId: "AAAAAAAA-AAAA-4000-8000-AAAAAAAAAAAA",
  expectedRevision: "a".repeat(64),
  expiry: "2026-11-06",
  fills: [
    {
      legId: "BBBBBBBB-BBBB-4000-8000-BBBBBBBBBBBB",
      closePrice: "0",
      closeFees: "-0.6527",
      strike: "55",
      openPrice: "3.54",
      openFees: "0",
    },
  ],
};

test("strict roll schema defaults NY date, normalizes UUIDs and parses negative fees losslessly", () => {
  expect(rollSchema.parse(raw, today)).toEqual({
    positionId: raw.positionId.toLowerCase(),
    expectedRevision: raw.expectedRevision,
    tradeDate: "2026-10-01",
    expiry: "2026-11-06",
    fills: [
      {
        legId: raw.fills[0]?.legId.toLowerCase(),
        closePrice: 0,
        closeFees: -6527,
        strike: 550000,
        openPrice: 35400,
        openFees: 0,
      },
    ],
  });
  expect(
    rollSchema.parse(
      { ...raw, fills: [{ ...raw.fills[0], closeFees: undefined, openFees: undefined }] },
      today,
    ).fills[0],
  ).toMatchObject({ closeFees: 0, openFees: 0 });
});

test.each([
  null,
  [],
  {},
  { ...raw, extra: 1 },
  { ...raw, positionId: "bad" },
  { ...raw, expectedRevision: "A".repeat(64) },
  { ...raw, tradeDate: "2026-10-02" },
  { ...raw, tradeDate: "2026-02-30" },
  { ...raw, expiry: "2026-10-01" },
  { ...raw, expiry: "2026-02-30" },
  { ...raw, fills: [] },
  { ...raw, fills: [null] },
  { ...raw, fills: [raw.fills[0], raw.fills[0]] },
  ...["closePrice", "openPrice", "strike", "closeFees", "openFees"].flatMap((key) =>
    ["1.12345", 1, "10000000000"].map((value) => ({
      ...raw,
      fills: [{ ...raw.fills[0], [key]: value }],
    })),
  ),
  ...["closePrice", "openPrice", "strike"].map((key) => ({
    ...raw,
    fills: [{ ...raw.fills[0], [key]: "-1" }],
  })),
  ...["closeFees", "openFees"].map((key) => ({
    ...raw,
    fills: [{ ...raw.fills[0], [key]: "0.01" }],
  })),
  { ...raw, fills: [{ ...raw.fills[0], strike: "0" }] },
  { ...raw, fills: [{ ...raw.fills[0], legId: "bad" }] },
  { ...raw, fills: [{ ...raw.fills[0], quantity: 1 }] },
])("rejects malformed roll boundaries %#", (body) => {
  expect(() => rollSchema.parse(body, today)).toThrow(RangeError);
});
