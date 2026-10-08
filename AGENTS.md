# Latinum

Single-user personal finance tracker, starting with an options trading journal. Vite + React web,
Hono API on Vercel, Neon Postgres via Drizzle, PGlite in tests. TypeScript strict, Biome,
Vitest 5, Playwright. Node 24, pnpm.

## Commands

Gate before a PR: `pnpm lint && pnpm typecheck && pnpm db:drift && pnpm test && pnpm build`.
Run `pnpm e2e` when touching `src/web` or routing. `pnpm test` includes coverage thresholds.
After editing `src/db/schema.ts`, run `pnpm db:generate` and commit the generated files.

## Layout

- `src/domain`: pure math, depends on nothing. Biome bans I/O, framework and layer imports here.
- `src/db`: schema, repository, Money4 column mapping. `src/api`: Hono app. `src/web`: React.
- `api/index.ts`: Vercel entry. `drizzle/`: migrations. `e2e/`: Playwright. `biome/`: GritQL rules.
- `web` and `api` depend on `domain`; `domain` never imports them.

## Conventions

- Money is `Money4` integers (1/10,000 USD); round to cents only at display. USD only.
- No `parseFloat`, `Number()` or `Math.round` in `src/domain` (lint error). Parsing lives in
  `src/domain/money.ts`.
- Trading dates are America/New_York via `todayNY`. Never `CURRENT_DATE` or `now()::date`.
- Fixtures are literal numbers copied from the plan, never computed from the code under test.
- `expect.requireAssertions` is on. Weak matchers (`toBeDefined`, `toBeTruthy`, `toBeFalsy`,
  bare `toHaveBeenCalled`, and their `.not.` forms) are lint errors.
- Before keeping a test, check it would fail if every import returned `undefined`.
- A test for a gate (lint, budget, migration diff) runs the real gate, not a re-measurement.
- When a second fix fails the same check, write down the premise both fixes shared and test it
  before attempting a third.

## Plan

`docs/plan.md` holds the data conventions (2.1) and the task list (5). A task's acceptance list
is its definition of done.
