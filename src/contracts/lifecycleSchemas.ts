import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import { type Money4, parseMoney4 } from "../domain/money.ts";
import type { AssignInput, CloseInput, ExpireInput, LinkHedgeRequest } from "./lifecycle.ts";

export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new RangeError(`Expected object containing only ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new RangeError("Expected UUID");
  return value.toLowerCase();
}
function revision(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new RangeError("Expected lowercase SHA-256 position revision");
  return value;
}
function tradeDate(value: unknown, today: IsoDate): IsoDate {
  if (value === undefined) return today;
  if (typeof value !== "string") throw new RangeError("Expected tradeDate string");
  const date = parseIsoDate(value);
  if (date > today) throw new RangeError("Trade date cannot be future");
  return date;
}
function amount(value: unknown, fees = false): Money4 {
  if (fees && value === undefined) return parseMoney4("0");
  if (typeof value !== "string") throw new RangeError("Expected decimal USD string");
  const result = parseMoney4(value);
  if (fees ? result > 0 || result < -99_999_999_999_999 : result < 0 || result > 999_999_999_999) {
    throw new RangeError(
      fees
        ? "Fees must be zero or negative within storage range"
        : "Price must be nonnegative within storage range",
    );
  }
  return result;
}

/** Shared strict request schemas; return branded domain inputs, never float-parsed prices. */
export const closeSchema = {
  parse(value: unknown, today: IsoDate): CloseInput {
    const body = record(value, ["fills", "tradeDate", "expectedRevision"]);
    if (!Array.isArray(body.fills) || body.fills.length === 0)
      throw new RangeError("Expected nonempty per-leg fills");
    const fills = body.fills.map((value) => {
      const fill = record(value, ["legId", "quantity", "price", "fees"]);
      if (
        typeof fill.quantity !== "number" ||
        !Number.isSafeInteger(fill.quantity) ||
        fill.quantity <= 0 ||
        fill.quantity > 2_147_483_647
      ) {
        throw new RangeError("Quantity must be a positive database integer");
      }
      return {
        legId: uuid(fill.legId),
        quantity: fill.quantity,
        price: amount(fill.price),
        fees: amount(fill.fees, true),
      };
    });
    if (new Set(fills.map((fill) => fill.legId)).size !== fills.length)
      throw new RangeError("Duplicate leg fills");
    return {
      expectedRevision: revision(body.expectedRevision),
      tradeDate: tradeDate(body.tradeDate, today),
      fills,
    };
  },
};
export const expireSchema = {
  parse(value: unknown, today: IsoDate): ExpireInput {
    const body = record(value, ["tradeDate", "expectedRevision"]);
    return {
      expectedRevision: revision(body.expectedRevision),
      tradeDate: tradeDate(body.tradeDate, today),
    };
  },
};
export const assignSchema = {
  parse(value: unknown, today: IsoDate): AssignInput {
    const body = record(value, ["legId", "tradeDate", "fees", "expectedRevision"]);
    return {
      expectedRevision: revision(body.expectedRevision),
      legId: uuid(body.legId),
      tradeDate: tradeDate(body.tradeDate, today),
      fees: amount(body.fees, true),
    };
  },
};
export const linkHedgeSchema = {
  parse(value: unknown): LinkHedgeRequest {
    const body = record(value, ["campaignId", "expectedRevision"]);
    return { expectedRevision: revision(body.expectedRevision), campaignId: uuid(body.campaignId) };
  },
};
