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
    ["put", 1, "0.65"],
    ["put", 5, "3.25"],
    ["call", 10, "6.50"],
    ["stock", 100, "0.00"],
  ] as const)("defaults %s quantity %i to %s", (kind, quantity, expected) => {
    expect(defaultFeeInput(kind, quantity)).toBe(expected);
  });
});
