# Verifying a change

`pnpm verify` runs the CI gate in CI order and stops at the first failure:
`lint`, `typecheck`, `db:drift`, `test` (with coverage), `build`, `e2e`.

`e2e` is also the launch-and-drive step. Playwright starts the local API
(`src/api/server.ts`, an in-memory PGlite seeded with the prototype book, on
port 8788) and `vite preview` (port 4173, proxying `/api`), drives the real app,
and stops both. It reuses servers already listening on those ports when not in CI.
Do not start your own servers for it.

Evidence lands in `.verify/` (gitignored): full-page screenshots of the Sheet at
1400 px and 390 px, in Ember (OS dark) and Paper (OS light).

## Feature map

| Feature | Driven by | Pass means |
| --- | --- | --- |
| Positions Sheet totals | `e2e/sheet.spec.ts` | Footer and KPI strip read 77 contracts, $14,450, 3.33%, 47% ann., $458,398 deployed at 1400 px and 390 px |
| No horizontal overflow | `e2e/sheet.spec.ts` | `scrollWidth - clientWidth` is 0 for the page and the table at both widths |
| Hedge markers | `e2e/sheet.spec.ts` | The NVDA spread row shows `max`, `risk` and `RoR` |
| Filters | `e2e/sheet.spec.ts` | Hedges leaves 4 contracts in the footer, 77 in the KPI strip |
| Footer strings | `src/web/components/PositionsSheet.test.tsx` | Discord, Covered, CSP and prototype fixtures print their plan totals |
| Token contract | `src/web/theme/theme.contract.test.ts` | Every theme block has the full token set; no colour literals outside `tokens.css` |

Add a row here when a task adds a screen.
