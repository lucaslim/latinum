# trading-journal

Options trading journal. Vite + React shell, Hono API, deployed on Vercel.

## Setup

Requires Node 24 and pnpm (version pinned in `package.json`; enable with `corepack enable`).

```sh
pnpm install
pnpm exec playwright install chromium   # once, for e2e
```

## Scripts

| Script           | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Vite on `:5173` plus the Hono API on `:8787`; Vite proxies `/api`   |
| `pnpm lint`      | `biome check`                                                       |
| `pnpm typecheck` | `tsc --noEmit`                                                      |
| `pnpm test`      | Vitest (unit and build smoke test)                                  |
| `pnpm build`     | Typecheck, then `vite build` to `dist/`                             |
| `pnpm e2e`       | `vite build`, then Playwright against `vite preview` and a local API |
| `pnpm verify`    | The whole CI gate, then screenshots in `.verify/` (see `docs/verify.md`) |

`API_PORT` overrides the API port for `pnpm dev`. The local API serves the prototype book from
an in-memory PGlite that is migrated and seeded on every start; production reads Neon through
`DATABASE_URL`, one pool per request.

## Platform checks

```sh
scripts/smoke.sh https://trading-journal-r8lqy6j1u-lucaslims-projects-af1d1be4.vercel.app
```

The URL came from the successful GitHub Production deployment's `environment_url`.
Every deployment URL, including older ones, sits behind the same Vercel Authentication.
The script checks anonymous GET and HEAD on `/` and `/api/health`, without cookies
or redirect following. Only the observed 302 redirect to `https://vercel.com/sso-api`
passes; application responses and transport errors fail.

The installable manifest uses credentialed fetching, and its `start_url` is `/` so the
installed app always starts on the origin it was installed from. The service worker caches static assets only and excludes `/api/` navigation.

The daily `0 10 * * *` UTC cron targets `/api/cron/heartbeat`. Its handler fails
closed unless `CRON_SECRET` matches the bearer token; no secret is provisioned by
this change. `HeartbeatWriter` in `src/api/cron.ts` is the persistence seam; the app
injects `neonHeartbeatWriter` (`src/api/heartbeat.ts`), which connects with `DATABASE_URL`
and inserts a `platform_heartbeat` row (`source = 'vercel-cron'`) through the repository.
A failed write returns 500 so a broken connection shows up in the cron log.

## Layout

- `api/index.ts`: Vercel Function entry (`export default app`)
- `src/api/`: Hono app, mounted under `/api`
- `src/domain/`: pure logic shared by web and API
- `src/web/`: React app
- `e2e/`: Playwright tests
- `src/db/`: phase-1 schema, driver-neutral repository, money mapping and open-book seed
- `drizzle/`: ordered stable migrations (`0000` roles, `0001` schema)

## Database

`pnpm db:seed [local-path]` migrates and seeds local PGlite (default `.pglite/`). It never
connects to Neon and replaces only the prototype seed account's open book on reruns.
The synthetic opening fills preserve the fixture's covered-share basis and spread net
price; they do not represent historical assignments or rolls. The open-book DTO bridge
supports only the prototype's strategies; repository reads retain the full stored rows.

After changing `src/db/schema.ts`, run `pnpm db:generate` and commit all generated files.
`pnpm db:drift` rejects both tracked and untracked migration changes. Tests apply the real
chain in PGlite, exercise every CHECK, and prove app DML plus exact permission denials.
PGlite's username context enforces permissions but does not apply role login timezone
settings; tests verify the persisted UTC role setting, not a live Neon login.

Only a successful main-push CI check unlocks `pnpm db:migrate`, using the job-scoped
`DATABASE_URL_OWNER` GitHub secret. There is one Neon branch (`production`), no preview
DB, and no CI seed. The owner connection string must never go into Vercel. The SQL-created
`app_rw` role has no initial password; later provisioning sets it without rerunning or
changing the role migration. Live production privilege proof belongs to that provisioning.

## Connecting production

The `Connect production` workflow (`.github/workflows/connect-production.yml`) is
`workflow_dispatch` only and refuses to run outside `main`. Run it after the migration job
has applied the schema:

```sh
gh workflow run connect-production.yml --ref main -f action=provision
gh workflow run connect-production.yml --ref main -f action=verify-heartbeat   # after 10:00 UTC
```

`provision` runs `scripts/connect-production.ts` in one job: it generates a password and sets
it on `app_rw` through `DATABASE_URL_OWNER`, connects as `app_rw` to prove normal DML works
and `CREATE`, `ALTER`, `DROP`, `TRUNCATE` and reading `drizzle.__drizzle_migrations` fail with
SQLSTATE `42501`, creates `CRON_SECRET` in Vercel if absent, upserts `DATABASE_URL` (pooled
host, `app_rw`) for the Production target only, and redeploys the production build of that
commit. Secret values are registered with `::add-mask::`, never printed, and never leave the
job except into Vercel. Re-running rotates the `app_rw` password and resyncs Vercel. It
refuses to touch a `DATABASE_URL` that also targets Preview or Development. `verify-heartbeat`
reads the latest `vercel-cron` rows back from Neon as the owner.
