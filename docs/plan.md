# Engineering plan (excerpt)

Verbatim copy of sections 2.1 and 5 of the project's engineering plan, kept in the repo so an agent
can read each task's acceptance list without access to anywhere else. A task's acceptance list is
its definition of done. References to other sections (3.x security, 7 repo setup, research items,
inbox notes) point at the full plan and are not copied here; a task that depends on one will quote it.

## 2.1 Conventions

- **Money:** cash amounts (premium, proceeds, fees, P/L) are `numeric(14,4)`. Per-share prices and strikes are `numeric(12,4)`.
  - A Drizzle `customType` maps both to a branded TS integer `Money4`, worth 1/10,000 USD; `Number.MAX_SAFE_INTEGER` still covers $900 billion.
  - All sums are integer sums, and display rounds to cents at the edge.
  - Why not integer cents: IBKR reports commissions with sub-cent precision (ibflex models them as decimals; confirm on the first real export, research §3.6 item 5). Rounding each fill to cents would stop a month from reconciling against Cash Transactions.
  - Why not `numeric` read as a JS `number`: that path goes back through floats, which is the drift the prototype shows (E1).
- **IDs:** `uuid` primary keys with `DEFAULT gen_random_uuid()`, generated on the client side of the API so a whole roll or import can be written in one transaction without read-backs.
- **Dates:**
  - `trade_date` and `expiry` are `date` columns: the America/New_York calendar date.
  - `executed_at` is `timestamptz`; it is null for manual trades with no time.
  - `ALTER ROLE app_rw SET timezone = 'UTC'`, and no query uses `CURRENT_DATE` or `now()::date` for trading logic.
  - "Today" comes from `todayNY(now)`, built on `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`.
  - DTE is `expiry − todayNY` in calendar days, as the samples use.
  - Monthly P/L buckets by the closing trade's `trade_date`, not by its UTC timestamp.
- **Currency:** every money-bearing row has `currency char(3) CHECK (currency = 'USD')`. Import also asserts `fxRateToBase = 1` and fails the whole file otherwise (inbox 003: base currency is USD).
- **Tags:** `text[]` with a GIN index rather than tag tables. This is a single-user app with no tag metadata, so join tables would be abstraction ahead of need.
- **Phasing:** each table and column below is marked with the phase that adds it. A phase-1 migration does not create phase-3 tables.

## 5. Phase 1 plan (tracker)

Each task is independently shippable, meaning it merges and deploys without the next. Effort is in focused working days for one developer with an agent, rough and unmeasured.

Test tooling:
- Vitest 5 for unit and integration tests.
- PGlite for the repository layer.
- Playwright 1.63 for a small end-to-end suite against `vite preview` plus a local API on PGlite.

Fixture numbers come from research §2.4, the screenshots, and the prototype run in E1. Amounts are exact `Money4` values. "Gross" means before fees.

### T1. Repo scaffold (0.5 d)
- **Scope:** section 7 layout; `pnpm`, TypeScript, Biome, Vitest, Playwright; a Vite + React shell; `api/index.ts` with Hono `GET /api/health`; `vercel.json` (regions, rewrites); a CI workflow file. It is committed even if P3 = local-only, so it is ready when a remote exists.
- **Acceptance:**
  - `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes from a clean clone.
  - `pnpm dev` serves the shell and `/api/health` returns `{"ok":true}`.
- **Tests:** a health route test using Hono's `app.request()`; a build smoke test.

### T2. Platform spike: deploy, protect, cron, PWA (1 d). Needs the captain for account creation and the phone test.
- **Scope:**
  - The captain creates the Vercel and Neon projects; I create no accounts.
  - Neon `aws-us-east-1`, migration 0000 (roles, section 3.5), and a `dev` branch.
  - Env vars per section 3.4.
  - Vercel Authentication on All Deployments.
  - The heartbeat cron (section 3.3).
  - PWA manifest with `useCredentials: true`.
- **Acceptance:**
  1. Anonymous `curl -sI https://<prod>/` and `/api/health` do not reach the app.
  2. The cron heartbeat passes steps 3 and 4 of section 3.3.
  3. On the captain's iPhone: Safari login, Add to Home Screen, then open from the icon, reach `/api/health`, force-quit, and reopen a day later. Record whether it needed to log in again.
  4. `app_rw` cannot create tables on prod.
- **Tests:** `scripts/smoke.sh <url>`, which runs the curl checks and exits non-zero on any wrong status. The phone result is recorded by hand in the PR. **This task decides P2.**

### T3. Domain math library (1.5 d)
- **Scope:** `src/domain`, pure TS with no I/O. It contains:
  - `Money4` with parse, format, sum and ratio;
  - `todayNY`, `dte` and `term`;
  - the NYSE calendar;
  - per-strategy metrics: premium/debit, collateral, yield, annualized (D5 a: × 365 ÷ term; D5 b: ÷ DTE left, for the Stats toggle later), breakeven, return on risk, max profit and loss;
  - totals under the corrected rules;
  - scenario math (no assignment; assigned plus hedge payout);
  - wheel basis, called-away gain, and realized P/L net of fees.
- **Acceptance:** every fixture below passes, and coverage on `src/domain` is at least 95% of lines.
- **Fixtures, per row:**
  - Discord: AVGX 4,135 / 67,500 = 6.1%; MRVL 900 / 40,000 = 2.2%; MUU 1,500 / 25,000 = 6.0%. SPY 730/725 ×1 debit 52 gives collateral 52 "risk", role hedge.
  - Covered: MRVL 220C ×2 = 44,000 at 5.9%; DRAM 55C ×15 = 82,500 at 7.5%; TSMG 36C ×10 = 36,000 at 10.8%. TQQQ 60/55 put spread ×3, debit 468: max payout 1,500, max profit 1,032, return on risk 220.5%.
  - CSP: NVDL 26.67 ×15 = 40,005, with `adjusted = true` flagged.
- **Fixtures, totals (income-only premium and collateral, contracts = Σ qty):**
  - Discord: 82 contracts, 14,455 premium, 421,000 income collateral, blended 3.43%, hedge risk 192.
  - Covered: 77 contracts, 25,633 premium, 404,500 income collateral, blended 6.34%, capital deployed 404,968.
  - CSP: 82 contracts, 15,250 premium, 414,505 collateral, blended 3.68%.
  - Prototype book (`POS`): 77 contracts, 14,450 premium, 434,500 income collateral, blended 3.33%, annualized 47.4% (collateral-weighted), hedge cost 358, swing capital 23,540, deployed 458,398.
- **Fixtures, NVDL breakdown** (open 2026-09-15, expiry 2026-10-16, 31-day term):
  - premium 2,350, capital 72,500, hedge debit 218, payout 1,000;
  - net +2,132, 2.94% period, 34.6% annualized;
  - assigned plus hedge: cash 3,132 = 4.32%;
  - basis 72.20 / 68.10, hedge cut **0.78/sh** (not the sample's 0.86), effective 71.42 / 67.32.
- **Fixtures, wheel:** DRAM put 55 with 2.00 premium gives basis 53.00. After the 55C at 1.10 ×15 (1,650), adjusted basis is 51.90, and the called-away gain is (55 − 53) × 1,500 + 1,650 = 4,650.
- **Fixtures, realized P/L net of fees:**
  - MUU 25P ×10 expired: 1,500 − 6.60 = 1,493.40.
  - SPXL 240P ×2 sold 3.10, bought back 0.40: 540 − 2.60 = 537.40.
  - DRAM 55P ×15 assigned: 3,000 − 9.90 = 2,990.10, booked in the assignment month (D3).
- **Fixtures, dates:**
  - DTE Sep 18 as of Sep 10 = 8 (Discord); Aug 7 as of Jul 31 = 7 (covered).
  - `todayNY` at `2026-10-02T03:30:00Z` is `2026-10-01`, so DTE to 2026-10-16 is 15.
  - DST end: `2026-11-02T04:30:00Z` is `2026-11-01`.
  - Business-day DTE 2026-10-01 to 2026-10-16 = 11; 2026-11-20 to 2026-11-27 = 4 (Thanksgiving 11-26 closed); 2026-11-27 is an early close.
  - The Friday chip for the week of Good Friday 2026-04-03 shows Thu 2026-04-02.
  - `isTradingDay('2029-01-02')` throws.
- **Fixture, float guard:** the sum of 1.09 × 100 × 2 is exactly 218.0000, where the prototype gives 218.00000000000003.

### T4. Schema, migrations, repository layer, seed (1 d)
- **Scope:** the phase-1 tables of section 2.2 in Drizzle `pg-core`, with the `customType` money columns; `drizzle-kit generate`; a repository module that takes any Drizzle Postgres database (Neon `Pool` in prod, PGlite in tests); `pnpm db:seed`, which loads the prototype's sample book onto the `dev` branch.
- **Acceptance:**
  - Migrations apply cleanly to an empty PGlite and to the Neon `dev` branch.
  - `drizzle-kit generate` produces no diff afterwards, and CI asserts this.
  - Seeded totals equal the prototype-book fixture from T3.
- **Tests:**
  - Each check constraint rejects a bad row: currency `CAD`, positive fees, stock with a strike, mark price 0.
  - A round-trip of `Money4` through Postgres is lossless (1.0850, 26.67, −0.6527).
  - `positions.closed_on` agrees with leg balances after open, partial close and full close.
  - The role-privilege test from section 3.5.

### T5. Positions Sheet: read-only, desktop and phone (2 d). Wants the design tokens.
- **Scope:**
  - `GET /api/positions?status=open`.
  - The Sheet layout (D9 = a): Ticker, Strike, Type, side, Expiry, DTE, Qty, Premium, Collateral, Yield, Ann.
  - Row tints by role and strategy; markers `max`, `risk`, `cost`, `RoR`.
  - Filters All / Income / Hedges / Swings.
  - KPI strip and footer with corrected totals, plus a second footer line for hedge and swing capital.
  - Two-line cards below 760 px container width.
- **Acceptance:**
  - On the seed, the footer reads 77 contracts, $14,450, 3.33%, 47% ann. and $458,398 deployed.
  - The hedge row shows max and risk markers and is excluded from income totals.
  - No horizontal overflow at 1400 px or 390 px (the prototype's check: `scrollWidth == clientWidth`).
- **Tests:**
  - A Vitest component test renders the Sheet from the T3 fixtures and asserts the footer strings.
  - Playwright at both widths asserts the totals and the overflow check.
  - The token contract test.

### T6. Add and edit trade, with live derived panel (2 d)
- **Scope:**
  - Strategy chips: CSP, CC, put credit/debit spread, call credit/debit spread, long call/put, stock, day trade.
  - Ticker autocomplete from the user's own tickers first, then a local symbol list (research 5.3).
  - Expiry quick-chips: the next 7 Fridays, holiday-adjusted, with the monthly marked "M".
  - Default fee $0.65 per contract, editable.
  - Share-basis prefill for covered calls from an assignment.
  - Tag typeahead.
  - `POST /api/positions` creates campaign, position, legs and opening trades in one `db.transaction`.
  - `PATCH /api/trades/:id` edits manual trades.
  - Request bodies are validated with schemas shared with the client; look up the library's current docs at this task.
- **Acceptance:**
  - Each derived line recalculates on every input.
  - Saving DRAM 50P ×10 @ 1.85, opened 2026-09-25, expiring 2026-10-09, shows: premium $1,850, collateral $50,000, yield 3.70%, term 14 days, annualized 96.5% (prototype run: 0.9646), breakeven $48.15, cost basis if assigned $48.15/sh.
  - The new row appears in the Sheet without a reload.
  - Editing the fill price updates every derived value and the totals.
- **Tests:**
  - Form logic is unit-tested through the T3 functions, with no duplicated math.
  - An API test checks that an invalid body is a 400 and leaves no partial rows (transaction rollback).
  - Playwright adds a trade and checks the footer.

### T7. Position drill-down with scenarios (1.5 d)
- **Scope:** `GET /api/campaigns/:id`. Screens:
  - CSP campaign: legs, the capital formula, total premium, linked hedge box, and two scenario cards.
  - Covered call: wheel timeline, collateral, share basis, and the not-called / called-away cards.
  - Hedge: debit, max payout, max profit, breakeven, return on risk.
  - Swing: entry, manual mark (`PUT /api/legs/:id/mark`), unrealized P/L.
- **Acceptance:**
  - The NVDL campaign shows every number in the T3 NVDL fixture, including 0.78/sh and 71.42 / 67.32.
  - The DRAM wheel shows 53.00 basis and 51.90 adjusted.
  - The AAPL 250C at mark 5.10 against entry 7.80 shows unrealized −$270.
  - The CRWD 50 sh at 471.30 against 455.20 shows +$805.
- **Tests:** component tests per campaign type against the fixtures; one Playwright drill-down on phone width.

### T8. Lifecycle actions: close, expire, assign, link hedge (1.5 d)
- **Scope:**
  - `POST /api/positions/:id/close` (fill price, partial quantity allowed).
  - `/expire` (price 0, all open quantity).
  - `/assign`, which writes the option `assign` trade, a new stock leg and open trade at the strike, and the `assignments` row with `premium_per_share`, all in one transaction. It also offers "sell covered call" prefilled with the basis.
  - `/link-hedge`, which moves the position into a campaign.
- **Acceptance:**
  - The T3 realized fixtures reproduce end to end through the API: MUU 1,493.40, SPXL 537.40, DRAM 2,990.10.
  - A partial close of 5 of 10 books P/L pro rata and leaves 5 open.
  - Assigning DRAM 55P ×15 creates 1,500 shares with basis 53.00 and the wheel timeline.
- **Tests:**
  - Repository tests on PGlite for each action, including rollback when the stock insert fails.
  - An idempotency test: a second `/expire` is a 409, not a double booking.

### T9. Roll (1.5 d)
- **Scope:**
  - The roll form from the prototype: close the current leg, open the new leg, six expiry chips after the current expiry, live derived lines, and a leg picker on multi-leg campaigns.
  - `POST /api/rolls` writes the close trade, the new position with its legs and opening trade, the `rolls` row, and the chain (creating it if needed), all in one transaction, all carrying `roll_id`.
  - The chain timeline on the drill-down, and a "rolled" badge in the Sheet.
- **Acceptance (gross, before fees, then net of fees):**
  - QQQ 670/665 hedge ×2, opened at 0.70, rolled with close 0.42 and new spread 0.77: closing leg realized −56.00 gross; roll net debit −70.00; chain net −210.00 = −140 + 84 − 154.
  - TQQQ 55P ×20 (seeded chain 58P → 55P, chain net +4,100, first leg −800.00 gross and −813.20 net of 13.20 fees), rolled at the prototype defaults (close 3.19, new 3.54 for 2026-11-06): leg realized −1,480.00 gross; net credit +700.00; chain net +4,800.00.
  - The closed leg books in its close month (D4 = a).
- **Fees:** the prototype's roll math excludes fees, but its closed list includes them (−813.20). The build shows both, labelled. Monthly P/L always uses the net figure.
- **Tests:** T3-level unit tests for the roll math, a PGlite transaction test, and Playwright for the QQQ roll.

### T10. Monthly P/L dashboard (1 d)
- **Scope:**
  - `GET /api/pl/monthly`: bars plus a cumulative line.
  - Month drill-down: closed trades, a by-strategy table, win rate (`wins ÷ closed`), profit factor (`gross wins ÷ gross losses`).
  - Buckets by the New York `trade_date` of the closing trade; assigned-put premium books at assignment (D3); roll legs book in their close month (D4).
- **Acceptance:**
  - September 2026 on the seed totals +$6,624.67 (the prototype shows +$6,625).
  - A close executed at `2026-10-01T01:00:00Z` (21:00 EDT on Sep 30) books in September.
  - A T9 roll on 2026-10-01 creates an October bar.
- **Tests:** a pure aggregation unit test; an API test with the timezone-edge trade.

### T11. Export and backup (0.5 d)
- **Scope:** `GET /api/export` returns a JSON of all tables plus a CSV of trades with derived P/L. A Download button.
- **Acceptance:** importing the JSON into an empty PGlite reproduces the seed totals.
- **Tests:** round-trip test.

**Phase 1 total:** about 14 working days. The research estimated 1.5 weeks; the gap is T2 (platform and security), the fixture-heavy T3, and the role and transaction tests.

Ordering: T1 → T2 → T3 → T4 → T5 → T6, then T7, T8, T9, T10 and T11.
- T3 and T4 can run in parallel after T1, and T2 needs only T1.
- T7 needs T5. T8 needs T4 and T7. T9 needs T8, for the close path. T10 needs T8.
- Per the captain's workflow, each task brief gets a cold read against the code before it is dispatched.
