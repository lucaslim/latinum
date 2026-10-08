import { describe, expect, it } from "vitest";
import { defaultFeeInput, feeToApi } from "./fees.ts";

describe("fees", () => {
  it.each([
    ["1.30", "-1.3000"],
    ["0", "0.0000"],
    ["6.5", "-6.5000"],
  ])("sends a %s charge to the API as %s", (charge, expected) => {
    expect(feeToApi(charge)).toBe(expected);
  });

  it("rejects a negative charge", () => {
    expect(() => feeToApi("-1.30")).toThrow("Enter fees as a positive charge or zero");
  });

  it.each([
    [1, "0.65"],
    [10, "6.50"],
  ])("defaults %i contracts to %s", (contracts, expected) => {
    expect(defaultFeeInput(contracts)).toBe(expected);
  });
});
