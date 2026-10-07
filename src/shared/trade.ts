import { z } from "zod";
import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import { type Money4, parseMoney4 } from "../domain/money.ts";

const date = z.iso
  .date()
  .refine((value) => value >= "0100-01-01", { abort: true, error: "Year must be at least 0100" })
  .transform(parseIsoDate);
const decimal = z.string().regex(/^\d{1,8}(?:\.\d{1,4})?$/, { abort: true });
const positive = decimal.refine((s) => parseMoney4(s) > 0, "Must be greater than zero");
const fees = z.string().regex(/^\d{1,10}(?:\.\d{1,4})?$/, { abort: true });
const common = {
  underlying: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/),
  openedOn: date,
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  notes: z.string().max(4000).optional(),
};
const option = {
  expiry: date,
  quantity: z.int().positive().max(2147483647),
  adjusted: z.boolean(),
};
const fill = { price: positive, fees };
const spreadLeg = z.strictObject({ strike: positive, price: decimal, fees });
const cover = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("held"), basis: positive }),
  z.strictObject({ kind: z.literal("assigned"), stockLegId: z.uuid() }),
]);
const spread = { ...common, ...option, short: spreadLeg, long: spreadLeg };

export const createPositionSchema = z
  .discriminatedUnion("strategy", [
    z.strictObject({ strategy: z.literal("csp"), ...common, ...option, ...fill, strike: positive }),
    z.strictObject({
      strategy: z.literal("cc"),
      ...common,
      ...option,
      ...fill,
      strike: positive,
      cover,
    }),
    z.strictObject({ strategy: z.literal("put_credit_spread"), ...spread }),
    z.strictObject({ strategy: z.literal("call_credit_spread"), ...spread }),
    z.strictObject({
      strategy: z.literal("put_debit_spread"),
      ...spread,
      role: z.enum(["hedge", "swing"]),
    }),
    z.strictObject({
      strategy: z.literal("call_debit_spread"),
      ...spread,
      role: z.enum(["hedge", "swing"]),
    }),
    z.strictObject({
      strategy: z.literal("long_call"),
      ...common,
      ...option,
      ...fill,
      strike: positive,
      role: z.enum(["hedge", "swing"]),
    }),
    z.strictObject({
      strategy: z.literal("long_put"),
      ...common,
      ...option,
      ...fill,
      strike: positive,
      role: z.enum(["hedge", "swing"]),
    }),
    z.strictObject({
      strategy: z.literal("stock"),
      ...common,
      ...fill,
      shares: z.int().positive().max(2147483647),
    }),
    z.strictObject({
      strategy: z.literal("day_trade"),
      ...common,
      ...fill,
      shares: z.int().positive().max(2147483647),
    }),
  ])
  .superRefine((p, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if ("expiry" in p && p.expiry <= p.openedOn) issue("Expiry must be after opening date");
    if ("short" in p) {
      const short = parseMoney4(p.short.strike);
      const long = parseMoney4(p.long.strike);
      const credit = p.strategy.endsWith("credit_spread");
      const put = p.strategy.startsWith("put_");
      if (credit === put ? short <= long : short >= long) issue("Strikes are reversed");
      const net = credit
        ? parseMoney4(p.short.price) - parseMoney4(p.long.price)
        : parseMoney4(p.long.price) - parseMoney4(p.short.price);
      if (net <= 0 || net >= Math.abs(short - long))
        issue("Net premium must be between zero and spread width");
    }
    const quantity = "shares" in p ? p.shares : p.quantity * 100;
    const prices =
      "short" in p
        ? [p.short.price, p.long.price]
        : p.strategy === "cc" && p.cover.kind === "held"
          ? [p.price, p.cover.basis]
          : [p.price];
    if (p.strategy === "cc" && p.cover.kind === "held" && quantity > 2147483647)
      issue("Covered shares exceed storage quantity");
    if (prices.some((price) => parseMoney4(price) * quantity > 99999999999999))
      issue("Cash exceeds storage precision");
    if (p.strategy === "csp" && parseMoney4(p.price) >= parseMoney4(p.strike))
      issue("Put premium must be below strike");
  });

export const patchTradeSchema = z
  .strictObject({ price: decimal.optional(), fees: fees.optional() })
  .refine((p) => p.price !== undefined || p.fees !== undefined, "Supply price or fees");

export type CreatePositionRequest = z.infer<typeof createPositionSchema>;
export type PatchTradeRequest = z.infer<typeof patchTradeSchema>;
export type TradeStrategy = CreatePositionRequest["strategy"];
export interface CreatePositionResponse {
  positionId: string;
  campaignId: string;
}
export interface PatchTradeResponse {
  id: string;
}
export interface AssignedStockOption {
  legId: string;
  underlying: string;
  uncoveredShares: number;
  basis: Money4;
  assignedOn: IsoDate;
}
export interface TradeFormOptions {
  tickers: string[];
  tags: string[];
  assignedStock: AssignedStockOption[];
}
export interface ManualTrade {
  id: string;
  legId: string;
  kind: "put" | "call" | "stock";
  side: "long" | "short";
  strike: Money4 | null;
  expiry: IsoDate | null;
  tradeDate: IsoDate;
  quantity: number;
  price: Money4;
  fees: Money4;
  editable: boolean;
}
export interface ManualTradesResponse {
  positionId: string;
  trades: ManualTrade[];
}

export const TRADE_STRATEGIES: readonly TradeStrategy[] = [
  "csp",
  "cc",
  "put_credit_spread",
  "put_debit_spread",
  "call_credit_spread",
  "call_debit_spread",
  "long_call",
  "long_put",
  "stock",
  "day_trade",
];
export const STRATEGY_LABELS: Record<TradeStrategy, string> = {
  csp: "CSP",
  cc: "CC",
  put_credit_spread: "Put credit spread",
  put_debit_spread: "Put debit spread",
  call_credit_spread: "Call credit spread",
  call_debit_spread: "Call debit spread",
  long_call: "Long call",
  long_put: "Long put",
  stock: "Stock",
  day_trade: "Day trade",
};
