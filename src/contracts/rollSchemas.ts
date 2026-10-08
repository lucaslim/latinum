import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import { closeSchema, isUuid } from "./lifecycleSchemas.ts";
import type { RollInput } from "./roll.ts";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new RangeError(`Expected object containing only ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}

export const rollSchema = {
  parse(value: unknown, today: IsoDate): RollInput {
    const body = record(value, ["positionId", "expectedRevision", "tradeDate", "expiry", "fills"]);
    if (typeof body.positionId !== "string" || !isUuid(body.positionId))
      throw new RangeError("Expected UUID");
    if (!Array.isArray(body.fills) || body.fills.length === 0)
      throw new RangeError("Expected nonempty per-leg fills");
    const fills = body.fills.map((fill) =>
      record(fill, ["legId", "closePrice", "closeFees", "strike", "openPrice", "openFees"]),
    );
    // The quantity is resolved from live balances, not supplied by the roll caller.
    const parse = (price: string, fees?: string) =>
      closeSchema.parse(
        {
          expectedRevision: body.expectedRevision,
          tradeDate: body.tradeDate,
          fills: fills.map((fill) => ({
            legId: fill.legId,
            quantity: 1,
            price: fill[price],
            fees: fees ? fill[fees] : undefined,
          })),
        },
        today,
      );
    const closing = parse("closePrice", "closeFees");
    const opening = parse("openPrice", "openFees");
    const strikes = parse("strike");
    if (strikes.fills.some((fill) => fill.price === 0))
      throw new RangeError("Strike must be positive");
    if (typeof body.expiry !== "string") throw new RangeError("Expected expiry string");
    const expiry = parseIsoDate(body.expiry);
    if (expiry <= closing.tradeDate) throw new RangeError("Expiry must be after trade date");
    return {
      positionId: body.positionId.toLowerCase(),
      expectedRevision: closing.expectedRevision,
      tradeDate: closing.tradeDate,
      expiry,
      fills: closing.fills.map((fill, i) => {
        const open = opening.fills[i];
        const strike = strikes.fills[i];
        if (!open || !strike) throw new Error("Roll fill parsing lost correspondence");
        return {
          legId: fill.legId,
          closePrice: fill.price,
          closeFees: fill.fees,
          strike: strike.price,
          openPrice: open.price,
          openFees: open.fees,
        };
      }),
    };
  },
};
