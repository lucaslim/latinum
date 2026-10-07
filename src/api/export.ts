import type { Handler } from "hono";
import type { WithDb } from "../db/database.ts";
import { readJournalExport } from "../db/export.ts";
import { type JournalExport, TRADE_CSV_COLUMNS } from "../db/export.types.ts";
import { formatMoney4, type Money4 } from "../domain/money.ts";

function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tradesCsv(trades: JournalExport["tables"]["trades"]): string {
  const rows = trades.map((trade) =>
    TRADE_CSV_COLUMNS.map((column) => {
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

    const backup = await withDb(readJournalExport);
    c.header("Cache-Control", "private, no-store");
    if (format === "csv") {
      c.header("Content-Disposition", 'attachment; filename="trading-journal-trades.csv"');
      c.header("Content-Type", "text/csv; charset=utf-8");
      return c.body(tradesCsv(backup.tables.trades));
    }
    c.header("Content-Disposition", 'attachment; filename="trading-journal-backup.json"');
    return c.json(backup);
  };
}
