import { sql } from "drizzle-orm";
import type { Money4 } from "../../domain/money.ts";
import type { Database } from "../database.ts";
import type { JournalExport } from "../export.types.ts";
import * as s from "../schema.ts";

export async function restoreExport(db: Database, backup: JournalExport): Promise<void> {
  const t = backup.tables;
  await db.transaction(async (tx) => {
    if (t.accounts.length)
      await tx
        .insert(s.accounts)
        .values(t.accounts.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })));
    if (t.campaigns.length) await tx.insert(s.campaigns).values(t.campaigns);
    if (t.roll_chains.length) await tx.insert(s.rollChains).values(t.roll_chains);
    if (t.positions.length) await tx.insert(s.positions).values(t.positions);
    if (t.legs.length)
      await tx
        .insert(s.legs)
        .values(t.legs.map((row) => ({ ...row, strike: row.strike as Money4 | null })));
    if (t.rolls.length) await tx.insert(s.rolls).values(t.rolls);
    if (t.trades.length)
      await tx.insert(s.trades).values(
        t.trades.map((row) => ({
          ...row,
          executedAt: row.executedAt === null ? null : new Date(row.executedAt),
          createdAt: new Date(row.createdAt),
          price: row.price as Money4,
          cash: row.cash as Money4,
          fees: row.fees as Money4,
        })),
      );
    if (t.assignments.length)
      await tx
        .insert(s.assignments)
        .values(
          t.assignments.map((row) => ({ ...row, premiumPerShare: row.premiumPerShare as Money4 })),
        );
    if (t.marks.length)
      await tx
        .insert(s.marks)
        .values(t.marks.map((row) => ({ ...row, price: row.price as Money4 })));
    for (const row of t.platform_heartbeat) {
      await tx.execute(sql`
        insert into platform_heartbeat (id, at, source) overriding system value
        values (${row.id}, ${new Date(row.at)}, ${row.source})
      `);
    }
  });
}
