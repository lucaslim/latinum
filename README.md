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
| `pnpm e2e`       | Playwright against `vite preview` of a fresh build                  |

`API_PORT` overrides the API port for `pnpm dev`.

## Layout

- `api/index.ts`: Vercel Function entry (`export default app`)
- `src/api/`: Hono app, mounted under `/api`
- `src/domain/`: pure logic shared by web and API
- `src/web/`: React app
- `e2e/`: Playwright tests
