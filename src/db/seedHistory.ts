import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { parseIsoDate } from "../domain/dates.ts";
import { parseMoney4 } from "../domain/money.ts";
import type { Database } from "./database.ts";
import { lifecycleRepository } from "./lifecycle.ts";
import { positionRevision } from "./positionRevision.ts";
import { type NewLeg, type NewPosition, type NewTrade, repository } from "./repository.ts";
import * as s from "./schema.ts";

// Source: trading-journal-research/prototypes/strikes.html, CLOSED (14 September rows),
// DRAM wheel and TQQQ chain. CLOSED is not a complete fill ledger: missing opening dates
// use Sep 1 (same day for day trades); missing prices/fees use minimal synthetic fills
// preserving the listed net result. QQQ's gross leg allocations are synthetic, too.
// These are fixture history, not reconstructed broker executions; HISTORY is not seeded.
function fill(
  action: NewTrade["action"],
  date: string,
  quantity: number,
  price: string,
  cash: string,
  fees: string,
  rollId?: string,
): NewTrade {
  return {
    action,
    tradeDate: date,
    quantity,
    price: parseMoney4(price),
    cash: parseMoney4(cash),
    fees: parseMoney4(fees),
    createdAt: new Date(`${date}T${action === "open" ? "14" : "20"}:00:00Z`),
    rollId,
  };
}
function stock(underlying: string, trades: NewTrade[]): NewLeg {
  return { underlying, kind: "stock", side: "long", multiplier: 1, trades };
}
function option(
  underlying: string,
  kind: "put" | "call",
  side: "long" | "short",
  strike: string,
  expiry: string,
  trades: NewTrade[],
): NewLeg {
  return { underlying, kind, side, strike: parseMoney4(strike), expiry, multiplier: 100, trades };
}
type HistoryPosition = Pick<NewPosition, "underlying" | "strategy" | "role" | "openedOn" | "legs">;

const closed: HistoryPosition[] = [
  {
    underlying: "TSLA",
    strategy: "day_trade",
    role: "swing",
    openedOn: "2026-09-03",
    legs: [
      stock("TSLA", [
        fill("open", "2026-09-03", 40, "438.10", "-17524", "-1"),
        fill("close", "2026-09-03", 40, "446.10", "17844", "-1"),
      ]),
    ],
  },
  {
    underlying: "NVDA",
    strategy: "day_trade",
    role: "swing",
    openedOn: "2026-09-08",
    legs: [
      stock("NVDA", [
        fill("open", "2026-09-08", 100, "100", "-10000", "-0.50"),
        fill("close", "2026-09-08", 100, "98.20", "9820", "-0.50"),
      ]),
    ],
  },
  {
    underlying: "SPXL",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      option("SPXL", "put", "short", "240", "2026-09-11", [
        fill("open", "2026-09-01", 2, "3.10", "620", "-1.30"),
        fill("close", "2026-09-11", 2, "0.40", "-80", "-1.30"),
      ]),
    ],
  },
  {
    underlying: "MUU",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      option("MUU", "put", "short", "25", "2026-09-11", [
        fill("open", "2026-09-01", 10, "1.50", "1500", "-6.60"),
        fill("expire", "2026-09-11", 10, "0", "0", "0"),
      ]),
    ],
  },
  {
    underlying: "SMCI",
    strategy: "stock",
    role: "swing",
    openedOn: "2026-09-01",
    legs: [
      stock("SMCI", [
        fill("open", "2026-09-01", 200, "48.20", "-9640", "-1"),
        fill("close", "2026-09-12", 200, "42", "8400", "-1"),
      ]),
    ],
  },
  {
    underlying: "SPY",
    strategy: "day_trade",
    role: "swing",
    openedOn: "2026-09-15",
    legs: [
      option("SPY", "call", "long", "655", "2026-09-15", [
        fill("open", "2026-09-15", 4, "1.10", "-440", "-1.30"),
        fill("close", "2026-09-15", 4, "2.12", "848", "-1.30"),
      ]),
    ],
  },
  {
    underlying: "AVGX",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      option("AVGX", "put", "short", "35", "2026-09-18", [
        fill("open", "2026-09-01", 10, "1.75", "1750", "-6.60"),
        fill("expire", "2026-09-18", 10, "0", "0", "0"),
      ]),
    ],
  },
  {
    underlying: "COIN",
    strategy: "long_call",
    role: "swing",
    openedOn: "2026-09-01",
    legs: [
      option("COIN", "call", "long", "340", "2026-09-25", [
        fill("open", "2026-09-01", 1, "9", "-900", "-0.65"),
        fill("close", "2026-09-19", 1, "3.40", "340", "-0.65"),
      ]),
    ],
  },
  {
    underlying: "QQQ",
    strategy: "put_debit_spread",
    role: "hedge",
    openedOn: "2026-09-01",
    legs: [
      option("QQQ", "put", "long", "675", "2026-09-25", [
        fill("open", "2026-09-01", 2, "2.50", "-500", "-1.30"),
        fill("close", "2026-09-22", 2, "4", "800", "-0.23"),
      ]),
      option("QQQ", "put", "short", "670", "2026-09-25", [
        fill("open", "2026-09-01", 2, "1", "200", "-1.30"),
        fill("close", "2026-09-22", 2, "1.30", "-260", "0"),
      ]),
    ],
  },
  {
    underlying: "MRVL",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      option("MRVL", "put", "short", "200", "2026-09-25", [
        fill("open", "2026-09-01", 2, "4.50", "900", "-1.30"),
        fill("expire", "2026-09-25", 2, "0", "0", "0"),
      ]),
    ],
  },
  {
    underlying: "NVDL",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      option("NVDL", "put", "short", "30", "2026-09-25", [
        fill("open", "2026-09-01", 10, "0.90", "900", "-6.60"),
        fill("expire", "2026-09-25", 10, "0", "0", "0"),
      ]),
    ],
  },
  {
    underlying: "AMD",
    strategy: "day_trade",
    role: "swing",
    openedOn: "2026-09-29",
    legs: [
      stock("AMD", [
        fill("open", "2026-09-29", 60, "100", "-6000", "-0.60"),
        fill("close", "2026-09-29", 60, "98.44", "5906.40", "-0.60"),
      ]),
    ],
  },
];

export async function seedHistory(db: Database, accountId: string) {
  const repo = repository(db);
  for (const position of closed) {
    const campaignId = randomUUID();
    await db.insert(s.campaigns).values({
      id: campaignId,
      accountId,
      title: position.underlying,
      openedOn: position.openedOn,
    });
    await repo.createPosition({ ...position, campaignId });
  }
  const openRows = await repo.readOpenPositions(accountId);
  const call = openRows.find((p) => p.underlying === "DRAM" && p.strategy === "cc");
  const currentPut = openRows.find((p) => p.underlying === "TQQQ" && p.strategy === "csp");
  if (!call || !currentPut) throw new Error("History requires the seeded DRAM call and TQQQ put");

  await db
    .update(s.campaigns)
    .set({ openedOn: "2026-08-21" })
    .where(eq(s.campaigns.id, call.campaignId));
  const putId = await repo.createPosition({
    campaignId: call.campaignId,
    underlying: "DRAM",
    strategy: "csp",
    role: "income",
    openedOn: "2026-08-21",
    legs: [
      option("DRAM", "put", "short", "55", "2026-09-18", [
        fill("open", "2026-08-21", 15, "2", "3000", "-9.90"),
      ]),
    ],
  });
  const put = (await repo.readOpenPositions(accountId)).find((p) => p.id === putId);
  if (!put?.legs[0]) throw new Error("Seeded DRAM put missing");
  const result = await lifecycleRepository(db).assignPosition(put.id, {
    legId: put.legs[0].id,
    expectedRevision: positionRevision(
      put,
      put.legs,
      put.legs.flatMap((leg) => leg.trades),
    ),
    tradeDate: parseIsoDate("2026-09-18"),
    fees: parseMoney4("0"),
  });
  if (!result?.assignment) throw new Error("Seeded DRAM assignment missing");
  const callLeg = call.legs.find((leg) => leg.kind === "call");
  if (!callLeg) throw new Error("Seeded DRAM call leg missing");
  await db
    .update(s.legs)
    .set({ coveredLegId: result.assignment.stockLegId })
    .where(eq(s.legs.id, callLeg.id));

  const rollChainId = randomUUID();
  const rollId = randomUUID();
  await db
    .update(s.campaigns)
    .set({ openedOn: "2026-08-28" })
    .where(eq(s.campaigns.id, currentPut.campaignId));
  await db.insert(s.rollChains).values({ id: rollChainId, campaignId: currentPut.campaignId });
  await db.insert(s.rolls).values({ id: rollId, rollChainId, rolledOn: "2026-09-24" });
  await repo.createPosition({
    campaignId: currentPut.campaignId,
    rollChainId,
    underlying: "TQQQ",
    strategy: "csp",
    role: "income",
    openedOn: "2026-08-28",
    legs: [
      option("TQQQ", "put", "short", "58", "2026-09-25", [
        fill("open", "2026-08-28", 20, "1.70", "3400", "-6.60"),
        fill("close", "2026-09-24", 20, "2.10", "-4200", "-6.60", rollId),
      ]),
    ],
  });
  await db.update(s.positions).set({ rollChainId }).where(eq(s.positions.id, currentPut.id));
  const opening = currentPut.legs
    .flatMap((leg) => leg.trades)
    .find((trade) => trade.action === "open");
  if (!opening) throw new Error("Seeded TQQQ opening trade missing");
  await db.update(s.trades).set({ rollId }).where(eq(s.trades.id, opening.id));
}
