# Export and backup

## T11 scope split (2026-10-07)

This delivery implements JSON backup and raw trade CSV. The derived/realized P/L CSV column
from `docs/plan.md` T11 is deferred to a follow-up on top of T8's partial-close accounting.
No P/L allocator, import endpoint, or schema change is included.

## Route contract

- `GET /api/export` and `GET /api/export?format=json` return a JSON attachment named
  `trading-journal-backup.json` (`application/json`).
- `GET /api/export?format=csv` returns a CSV attachment named `trading-journal-trades.csv`
  (`text/csv; charset=utf-8`).
- Any other format, including an empty format, returns HTTP 400.
- Export responses use `Cache-Control: private, no-store`.

JSON follows `JournalExport` in `src/db/export.types.ts`: `{ version: 1, tables: { ... } }`.
The table keys are the ten application table names, including `platform_heartbeat`;
Drizzle migration bookkeeping is excluded. Row properties use the schema's camelCase names.
Money4 amounts are integer counts of 1/10,000 USD. Trading dates remain `YYYY-MM-DD`;
timestamps use UTC ISO strings at the existing database adapter's millisecond precision.
Nulls, IDs, tags, relationships, and closed rows are preserved. JSON tables are read in one
repeatable-read, read-only transaction and sorted by primary key (the composite key for marks).

CSV contains every stored trade column, in `TRADE_CSV_COLUMNS` order, with no derived columns.
Money is formatted as four-decimal USD amounts rather than scaled integers. Timestamps use
UTC ISO strings; nullable columns are empty fields. CSV uses CRLF records and standard
comma/quote/newline escaping. CSV uses one trades-only query sorted by ID and does not depend
on unrelated backup tables.

The Download control offers JSON backup and raw trade CSV. The automated acceptance test
restores downloaded JSON into a separately migrated, empty PGlite and checks the plan's seed
totals. Restore is test-only; this is not a user-facing import workflow.
