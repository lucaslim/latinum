import type { Handler } from "hono";
import type { WithDb } from "../db/database.ts";
import { readJournalExport, readTradeExport } from "../db/export.ts";
import { type JournalExport, TRADE_CSV_COLUMNS } from "../db/export.types.ts";
import { parseIsoDate } from "../domain/dates.ts";
import { allocateRealizedTrades } from "../domain/lifecyclePnl.ts";
import { formatMoney4, type Money4 } from "../domain/money.ts";

function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tradesCsv(trades: JournalExport["tables"]["trades"]): string {
  const legs = new Map<string, JournalExport["tables"]["trades"]>();
  for (const trade of trades) {
    const events = legs.get(trade.legId) ?? [];
    events.push(trade);
    legs.set(trade.legId, events);
  }
  const realized = new Map<string, Money4>();
  for (const events of legs.values()) {
    events.sort(
      (a, b) =>
        a.tradeDate.localeCompare(b.tradeDate) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    for (const allocation of allocateRealizedTrades(
      events.map((trade) => ({
        id: trade.id,
        action: trade.action,
        date: parseIsoDate(trade.tradeDate),
        quantity: trade.quantity,
        cash: trade.cash as Money4,
        fees: trade.fees as Money4,
      })),
    )) {
      realized.set(allocation.tradeId, allocation.pnl);
    }
  }
  const rows = trades.map((trade) =>
    TRADE_CSV_COLUMNS.map((column) => {
      if (column === "realizedPnl") {
        const pnl = realized.get(trade.id);
        return pnl === undefined ? "" : formatMoney4(pnl, 4);
      }
      const value = trade[column];
      return csvField(
        column === "price" || column === "cash" || column === "fees"
          ? formatMoney4(trade[column] as Money4, 4)
          : value,
      );
    }).join(","),
  );
  return `${[TRADE_CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

export function exportRoute({ withDb }: { withDb: WithDb }): Handler {
  return async (c) => {
    const format = c.req.query("format") ?? "json";
    if (format !== "json" && format !== "csv")
      return c.json({ error: "format must be json or csv" }, 400);

    if (format === "csv") {
      const trades = await withDb(readTradeExport);
      c.header("Cache-Control", "private, no-store");
      c.header("Content-Disposition", 'attachment; filename="trading-journal-trades.csv"');
      c.header("Content-Type", "text/csv; charset=utf-8");
      return c.body(tradesCsv(trades));
    }
    const backup = await withDb(readJournalExport);
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Disposition", 'attachment; filename="trading-journal-backup.json"');
    return c.json(backup);
  };
}
