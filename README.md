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
| `pnpm e2e`       | `vite build`, then Playwright against `vite preview`                |

`API_PORT` overrides the API port for `pnpm dev`.

## Platform checks

```sh
scripts/smoke.sh https://trading-journal-r8lqy6j1u-lucaslims-projects-af1d1be4.vercel.app
```

The URL came from the successful GitHub Production deployment's `environment_url`.
The script checks anonymous GET and HEAD on `/` and `/api/health`, without cookies
or redirect following. Only the observed 302 redirect to `https://vercel.com/sso-api`
passes; application responses and transport errors fail.

The installable manifest uses credentialed fetching and starts on that production
origin. The service worker caches static assets only and excludes `/api/` navigation.

The daily `0 10 * * *` UTC cron targets `/api/cron/heartbeat`. Its handler fails
closed unless `CRON_SECRET` matches the bearer token; no secret is provisioned by
this change. `HeartbeatWriter` in `src/api/cron.ts` is the typed persistence seam,
currently a no-op. Database wiring, production cron proof, and installed iPhone
login/persistence testing remain follow-up work.

## Layout

- `api/index.ts`: Vercel Function entry (`export default app`)
- `src/api/`: Hono app, mounted under `/api`
- `src/domain/`: pure logic shared by web and API
- `src/web/`: React app
- `e2e/`: Playwright tests
