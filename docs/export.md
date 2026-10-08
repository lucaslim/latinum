# Export and backup

## T11 and T11b

T11 implements JSON backup and raw trade CSV. T11b adds the derived `realizedPnl` CSV
column using T8's partial-close allocator. No import endpoint or schema change is included.

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

CSV contains every stored trade column followed by `realizedPnl`, in `TRADE_CSV_COLUMNS`
order. Money is formatted as four-decimal USD amounts rather than scaled integers.
`realizedPnl` is blank for opening trades; close, expire, assign and exercise trades contain
net realized P/L from T8's allocator, including `0.0000` for a zero result. Each leg is
allocated in `tradeDate`, `createdAt`, `id` order, using only preceding opens in a
weighted-average pool. Opening cash and fees truncate separately for partial closes; the
final close consumes the remainders, and reopening starts a fresh pool. JSON stays raw.

Timestamps use UTC ISO strings; nullable columns are empty fields. CSV uses CRLF records
and standard comma/quote/newline escaping. CSV uses one trades-only query sorted by ID and
does not depend on unrelated backup tables. Allocation does not change CSV row order.
Invalid histories, such as a close without sufficient preceding opens, fail the CSV export
at the API error boundary rather than emitting misleading P/L.

The Download control offers JSON backup and raw trade CSV. The automated acceptance test
restores downloaded JSON into a separately migrated, empty PGlite and checks the plan's seed
totals. Restore is test-only; this is not a user-facing import workflow.
