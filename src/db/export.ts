import type { Database } from "./database.ts";
import type { JournalExport } from "./export.types.ts";
import * as s from "./schema.ts";

export function readJournalExport(db: Database): Promise<JournalExport> {
  return db.transaction(
    async (tx) => ({
      version: 1,
      tables: {
        accounts: (await tx.select().from(s.accounts).orderBy(s.accounts.id)).map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
        campaigns: await tx.select().from(s.campaigns).orderBy(s.campaigns.id),
        roll_chains: await tx.select().from(s.rollChains).orderBy(s.rollChains.id),
        positions: await tx.select().from(s.positions).orderBy(s.positions.id),
        legs: await tx.select().from(s.legs).orderBy(s.legs.id),
        rolls: await tx.select().from(s.rolls).orderBy(s.rolls.id),
        trades: (await tx.select().from(s.trades).orderBy(s.trades.id)).map((row) => ({
          ...row,
          executedAt: row.executedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        assignments: await tx.select().from(s.assignments).orderBy(s.assignments.id),
        marks: await tx.select().from(s.marks).orderBy(s.marks.legId, s.marks.asOf, s.marks.source),
        platform_heartbeat: (
          await tx.select().from(s.platformHeartbeat).orderBy(s.platformHeartbeat.id)
        ).map((row) => ({ ...row, at: row.at.toISOString() })),
      },
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
