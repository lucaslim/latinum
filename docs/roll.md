# Roll

`POST /api/rolls` rolls every open option leg of one position, retaining its campaign,
strategy, role and quantities. The campaign's position picker selects the whole position;
a spread closes and replaces both constituent legs. Stock is not a roll leg. A covered
call retains its existing shares rather than booking a fictitious stock sale/purchase.

```json
{
  "positionId": "<uuid>",
  "expectedRevision": "<observed campaign position revision>",
  "tradeDate": "2026-10-01",
  "expiry": "2026-11-06",
  "fills": [
    {
      "legId": "<old option leg uuid>",
      "closePrice": "3.19",
      "closeFees": "-13.00",
      "strike": "55",
      "openPrice": "3.54",
      "openFees": "-13.00"
    }
  ]
}
```

Prices and strikes are decimal USD strings; fees are zero or negative decimal charges.
Omitted fees are zero. The close date defaults to today in New York and cannot be future.
The replacement expiry is later than the current expiry. The form offers six subsequent
holiday-adjusted Friday expiries and recalculates gross/net derived amounts as inputs change.

One transaction reuses the lifecycle close path, creates the replacement position, legs
and opening trades, and records the roll and chain. Both close and new opening trades carry
`roll_id`; previous opening trades keep their original links. A stale observed revision
returns `409` with `code: "stale_revision"`. Reload before retrying an uncertain write or a
successful write whose refresh failed. The response and campaign reads are uncached.

The response adds `rollId`, `rollChainId`, `newPositionId` and `metrics` to the lifecycle
response. All amounts are integer `Money4`:

- `realizedGross` / `realizedNet`: the old option's allocated P/L before/after fees.
- `rollCashGross` / `rollCashNet`: this close plus the replacement opening cash.
- `chainCashGross` / `chainCashNet`: signed cash for all option trades in the chain.

Chain cash includes the still-open replacement and is **not** realized P/L. Realized
allocations use the lifecycle weighted-average allocator and book in the closing trade's
New York `tradeDate` month, including rolls. Monthly P/L consumes net allocations.

## Acceptance fixtures

- QQQ 670/665 put debit spread ×2: opening −$140, close +$84, replacement −$154;
  realized −$56 gross, roll cash −$70 gross, chain cash −$210 gross.
- TQQQ 58P ×20: opened 2026-08-28 at $1.70 (+$3,400), closed 2026-09-24
  at $2.10 (−$4,200), $13.20 combined fees; realized −$800 gross / −$813.20 net.
  Its 55P replacement opened 2026-09-24 at $2.45 (+$4,900), making chain cash +$4,100.
  Closing at $3.19 and replacing at $3.54 for 2026-11-06 realizes −$1,480 gross,
  adds +$700 gross roll cash and leaves +$4,800 gross chain cash.

The literal historical chain is exercised in PGlite tests. Historical production seed is
owned by the concurrent monthly-P/L work, not this change. After rebasing onto that seed,
run `T9_SEEDED_CHAIN=1 pnpm exec vitest run src/db/rollSeed.test.ts` to enable the additional
`seedBook` acceptance check; it is explicitly skipped until that dependency lands.
