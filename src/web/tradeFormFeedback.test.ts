import { describe, expect, it } from "vitest";
import { previewTrade } from "../shared/tradeForm.ts";
import { tradeFormFeedback } from "./tradeFormFeedback.ts";

const csp = {
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
const feedback = (raw: unknown, spread = false) => {
  const preview = previewTrade(raw, []);
  if (preview.success) throw new Error("Expected invalid fixture");
  return tradeFormFeedback(raw, preview.errors, spread);
};

describe("tradeFormFeedback", () => {
  it("names invalid fields in ticket order instead of leaking schema messages", () => {
    expect(
      feedback({
        ...csp,
        underlying: "?",
        quantity: 0,
        expiry: "",
        strike: "no",
        price: "",
        fees: "-1",
        openedOn: "",
        tags: [""],
        notes: "x".repeat(4001),
      }),
    ).toEqual(["Needs ticker, quantity, expiry, strike, fill, fees, tags, notes, opened date"]);
  });

  it("groups invalid spread legs and accepts zero fills", () => {
    const raw = {
      ...csp,
      strategy: "put_debit_spread",
      role: "hedge",
      strike: undefined,
      price: undefined,
      fees: undefined,
      long: { strike: "", price: "bad", fees: "0.65" },
      short: { strike: "0", price: "0", fees: "0.65" },
    };
    const { strike: _strike, price: _price, fees: _fees, ...spread } = raw;
    expect(feedback(spread, true)).toEqual(["Needs strikes, fills"]);
  });

  it("names held-share basis and an invalid assigned-share choice", () => {
    expect(feedback({ ...csp, strategy: "cc", cover: { kind: "held", basis: "" } })).toEqual([
      "Needs share basis",
    ]);
    expect(
      feedback({ ...csp, strategy: "cc", cover: { kind: "assigned", stockLegId: "" } }),
    ).toEqual(["Needs covered shares"]);
  });

  it("names stock shares and unknown invalid fields without schema text", () => {
    expect(
      feedback({
        strategy: "stock",
        underlying: "DRAM",
        openedOn: "2026-09-25",
        shares: 0,
        price: "1",
        fees: "0",
        tags: [],
      }),
    ).toEqual(["Needs shares"]);
    expect(feedback({ ...csp, extra: true })).toEqual(["Needs trade details"]);
    expect(feedback({ ...csp, strategy: "long_put", role: "invalid" })).toEqual([
      "Needs trade details",
    ]);
  });

  it("retains trade-level sentences and Money4 range errors verbatim", () => {
    expect(feedback({ ...csp, expiry: "2026-09-25" })).toEqual([
      "Expiry must be after opening date",
    ]);
    expect(
      feedback({
        ...csp,
        strategy: "cc",
        cover: { kind: "assigned", stockLegId: "00000000-0000-4000-8000-000000000053" },
      }),
    ).toEqual(["Choose assigned shares available for this covered call"]);
    const raw = { ...csp, strike: "99999999", quantity: 2147483647, price: "0.0001" };
    const preview = previewTrade(raw, []);
    expect(preview.success).toBe(false);
    if (preview.success) throw new Error("Expected Money4 range error");
    expect(tradeFormFeedback(raw, preview.errors, false)).toEqual(preview.errors);
    expect(preview.errors.join(" ")).toContain("Money4");
  });
});
