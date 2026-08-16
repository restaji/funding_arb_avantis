# AGENTS.md

## Cursor Cloud specific instructions

This is a **Next.js 16 (App Router, Turbopack) + React 19 + TypeScript** app: an
Avantis-anchored funding-carry scanner across hedge venues (Variational, Ondo, GRVT).
See `README.md` for the domain model and `lib/strategy.ts` for the scan math.

### Services

There is a single service — the Next.js app. It has no database and **requires no
environment variables**; every venue endpoint is public and unauthenticated
(see the data-sources table in `README.md`).

- Dev server: `npm run dev` (Turbopack, http://localhost:3000). Standard command from `package.json`.
- Lint / typecheck: `npm run typecheck` (`tsc --noEmit`). There is no separate ESLint script.
- Build / prod: `npm run build` then `npm start`.

### Routes / how to verify quickly

- `/` — scanner UI (server component; calls `scan()` directly).
- `/api/funding` — raw funding per matched market.
- `/api/opportunities` — ranked paying pairs + withheld list. Fastest health check:
  `curl -s localhost:3000/api/opportunities` and confirm `venueErrors` is `{}` and
  `counts.avantisMarkets` / `counts.hedgeMarkets` are non-zero.

### Non-obvious caveats

- The scanner fetches live external venue APIs at request time. **Outbound network
  access is required** for the board to populate; with no network the page renders but
  markets are withheld and `venueErrors` is populated.
- Results are time/market-dependent. Expect most non-crypto markets to be withheld on
  weekends and outside US cash hours (Avantis trading-calendar gate) — this is correct
  behavior, not a failure. Crypto is always open.
- Routes revalidate every 120s, so the board is cached briefly; use the in-UI refresh
  button (a server action) to force a fresh scan.
