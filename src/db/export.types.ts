import type * as s from "./schema.ts";

type JsonValue<T> = T extends Date ? string : T extends number ? number : T;
type ExportRow<T> = { [K in keyof T]: JsonValue<T[K]> };

export interface JournalExport {
  version: 1;
  tables: {
    accounts: ExportRow<typeof s.accounts.$inferSelect>[];
    campaigns: ExportRow<typeof s.campaigns.$inferSelect>[];
    roll_chains: ExportRow<typeof s.rollChains.$inferSelect>[];
    positions: ExportRow<typeof s.positions.$inferSelect>[];
    legs: ExportRow<typeof s.legs.$inferSelect>[];
    rolls: ExportRow<typeof s.rolls.$inferSelect>[];
    trades: ExportRow<typeof s.trades.$inferSelect>[];
    assignments: ExportRow<typeof s.assignments.$inferSelect>[];
    marks: ExportRow<typeof s.marks.$inferSelect>[];
    platform_heartbeat: ExportRow<typeof s.platformHeartbeat.$inferSelect>[];
  };
}

export const TRADE_CSV_COLUMNS = [
  "id",
  "legId",
  "action",
  "tradeDate",
  "executedAt",
  "quantity",
  "price",
  "cash",
  "fees",
  "currency",
  "rollId",
  "source",
  "createdAt",
  "realizedPnl",
] as const satisfies readonly (keyof JournalExport["tables"]["trades"][number] | "realizedPnl")[];
