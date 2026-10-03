import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { moneyColumn } from "./money.ts";

export const strategy = pgEnum("strategy", [
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
]);
export const positionRole = pgEnum("position_role", ["income", "hedge", "swing"]);
export const legKind = pgEnum("leg_kind", ["put", "call", "stock"]);
export const side = pgEnum("side", ["long", "short"]);
export const tradeAction = pgEnum("trade_action", [
  "open",
  "close",
  "expire",
  "assign",
  "exercise",
]);
export const tradeSource = pgEnum("trade_source", ["manual", "ibkr_upload", "ibkr_flex"]);
const id = () => uuid().primaryKey().defaultRandom();
const at = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const price = () => moneyColumn({ precision: 12 });
const cash = () => moneyColumn({ precision: 14 });

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    label: text().notNull().unique(),
    broker: text().notNull(),
    createdAt: at(),
  },
  (t) => [check("accounts_broker", sql`${t.broker} in ('ibkr','manual')`)],
);
export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    title: text().notNull(),
    openedOn: date().notNull(),
    closedOn: date(),
    notes: text(),
  },
  (t) => [check("campaigns_dates", sql`${t.closedOn} is null or ${t.closedOn} >= ${t.openedOn}`)],
);
export const rollChains = pgTable("roll_chains", {
  id: id(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
});
export const positions = pgTable(
  "positions",
  {
    id: id(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id),
    rollChainId: uuid().references(() => rollChains.id),
    underlying: text().notNull(),
    strategy: strategy().notNull(),
    role: positionRole().notNull(),
    openedOn: date().notNull(),
    closedOn: date(),
    tags: text().array().notNull().default(sql`'{}'`),
    notes: text(),
  },
  (t) => [
    check("positions_underlying", sql`${t.underlying} ~ '^[A-Z][A-Z0-9.]{0,9}$'`),
    check("positions_dates", sql`${t.closedOn} is null or ${t.closedOn} >= ${t.openedOn}`),
    index("positions_open").on(t.campaignId).where(sql`${t.closedOn} is null`),
    index("positions_tags").using("gin", t.tags),
  ],
);
export const legs = pgTable(
  "legs",
  {
    id: id(),
    positionId: uuid()
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    kind: legKind().notNull(),
    side: side().notNull(),
    underlying: text().notNull(),
    strike: price(),
    expiry: date(),
    multiplier: integer().notNull().default(100),
    adjusted: boolean().notNull().default(false),
  },
  (t) => [
    check("legs_strike", sql`${t.strike} > 0`),
    check("legs_multiplier", sql`${t.multiplier} > 0`),
    check(
      "legs_shape",
      sql`(${t.kind} = 'stock' and ${t.strike} is null and ${t.expiry} is null) or (${t.kind} in ('put','call') and ${t.strike} is not null and ${t.expiry} is not null)`,
    ),
    check("legs_stock_multiplier", sql`${t.kind} <> 'stock' or ${t.multiplier} = 1`),
  ],
);
export const rolls = pgTable(
  "rolls",
  {
    id: id(),
    rollChainId: uuid()
      .notNull()
      .references(() => rollChains.id, { onDelete: "cascade" }),
    rolledOn: date().notNull(),
    detectedBy: text().notNull().default("manual"),
  },
  (t) => [
    check(
      "rolls_detected_by",
      sql`${t.detectedBy} in ('manual','order_id','timestamp','same_day')`,
    ),
  ],
);
export const trades = pgTable(
  "trades",
  {
    id: id(),
    legId: uuid()
      .notNull()
      .references(() => legs.id, { onDelete: "cascade" }),
    action: tradeAction().notNull(),
    tradeDate: date().notNull(),
    executedAt: timestamp({ withTimezone: true }),
    quantity: integer().notNull(),
    price: price().notNull(),
    cash: cash().notNull(),
    fees: cash().notNull().default(sql`0`),
    currency: char({ length: 3 }).notNull().default("USD"),
    rollId: uuid().references(() => rolls.id),
    source: tradeSource().notNull().default("manual"),
    createdAt: at(),
  },
  (t) => [
    check("trades_quantity", sql`${t.quantity} > 0`),
    check("trades_price", sql`${t.price} >= 0`),
    check("trades_fees", sql`${t.fees} <= 0`),
    check("trades_currency", sql`${t.currency} = 'USD'`),
    index("trades_leg").on(t.legId),
    index("trades_date").on(t.tradeDate),
  ],
);
export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    optionTradeId: uuid()
      .notNull()
      .unique()
      .references(() => trades.id),
    stockTradeId: uuid()
      .notNull()
      .unique()
      .references(() => trades.id),
    shares: integer().notNull(),
    premiumPerShare: price().notNull(),
  },
  (t) => [check("assignments_shares", sql`${t.shares} > 0`)],
);
export const marks = pgTable(
  "marks",
  {
    legId: uuid()
      .notNull()
      .references(() => legs.id, { onDelete: "cascade" }),
    asOf: date().notNull(),
    price: price().notNull(),
    source: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.legId, t.asOf, t.source] }),
    check("marks_price", sql`${t.price} > 0`),
    check("marks_source", sql`${t.source} in ('manual','feed')`),
  ],
);
export const platformHeartbeat = pgTable("platform_heartbeat", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  at: at(),
  source: text().notNull(),
});
