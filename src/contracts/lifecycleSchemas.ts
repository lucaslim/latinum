import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import { type Money4, parseMoney4 } from "../domain/money.ts";
import type { AssignInput, CloseInput, ExpireInput, LinkHedgeRequest } from "./lifecycle.ts";

/** Accept a UUID-shaped string using case-insensitive hexadecimal groups. */
export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Require a non-null object with only the allowed keys; throw RangeError otherwise. */
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
/** Validate a UUID string and normalize it to lowercase, or throw RangeError. */
function uuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new RangeError("Expected UUID");
  return value.toLowerCase();
}
/** Default an omitted date to today and reject invalid or future trading dates. */
function tradeDate(value: unknown, today: IsoDate): IsoDate {
  if (value === undefined) return today;
  if (typeof value !== "string") throw new RangeError("Expected tradeDate string");
  const date = parseIsoDate(value);
  if (date > today) throw new RangeError("Trade date cannot be future");
  return date;
}
/** Parse exact decimal USD within storage bounds; omitted fees default to zero. */
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
  /** Parse unique per-leg close fills and a nonfuture date; reject invalid values with RangeError. */
  parse(value: unknown, today: IsoDate): CloseInput {
    const body = record(value, ["fills", "tradeDate"]);
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
    return { tradeDate: tradeDate(body.tradeDate, today), fills };
  },
};
export const expireSchema = {
  /** Parse a strict expiration request, defaulting its trading date to today. */
  parse(value: unknown, today: IsoDate): ExpireInput {
    const body = record(value, ["tradeDate"]);
    return { tradeDate: tradeDate(body.tradeDate, today) };
  },
};
export const assignSchema = {
  /** Parse the assignment leg, nonfuture date and nonpositive fees into domain values. */
  parse(value: unknown, today: IsoDate): AssignInput {
    const body = record(value, ["legId", "tradeDate", "fees"]);
    return {
      legId: uuid(body.legId),
      tradeDate: tradeDate(body.tradeDate, today),
      fees: amount(body.fees, true),
    };
  },
};
export const linkHedgeSchema = {
  /** Parse a strict hedge-link request and normalize its target campaign UUID. */
  parse(value: unknown): LinkHedgeRequest {
    const body = record(value, ["campaignId"]);
    return { campaignId: uuid(body.campaignId) };
  },
};
