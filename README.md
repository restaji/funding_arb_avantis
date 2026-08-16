# Avantis × Variational, Ondo, GRVT or Pacifica — Funding Carry

A Vercel-deployable scanner for delta-neutral funding carry between **Avantis** and a hedge
venue — currently **Variational**, **Ondo Perps**, **GRVT** or **Pacifica** — across every
market they have in common.

Every pair is Avantis-anchored: Avantis sits on one leg, a hedge venue on the other. Each
asset is scored against every hedge venue that quotes it and only the best-paying pair
survives, so a venue can only add rows, never remove them. Only funding is modelled —
execution cost, spread, and fees are deliberately out of scope.

For the wider multi-venue design this was narrowed down from, see
[`funding_strategy.md`](./funding_strategy.md).

## The one thing to understand

Avantis charges a **borrow fee to the LPs on both sides**. A short does not receive the long
fee, it pays the short fee. So the Avantis leg is always a cost, and:

```
netCarry > 0   ⟺   hedgeRate < -avantisRate
```

The hedge has to out-earn the Avantis fee on its own. Avantis never generates edge here —
it is the position being financed, and the app's job is to find where financing it is cheap.

That fee starts at **15% a year** and runs to 100%, while the hedge venues sit at the same
10.95% baseline when their perp is on the oracle. So the honest expectation is a nearly empty
board: a pair only appears when hedge funding is strongly negative against a low-fee Avantis
pair. Two or three candidates is a normal day, not a bug.

## The asset universe is discovered, not hardcoded

Avantis publishes a Pyth-style symbol on every pair (`feed.attributes.symbol`, e.g.
`Crypto.BTC/USD`), so the tradeable set is computed at runtime as the union, across hedge
venues, of the intersection with the Avantis book. New markets on any side appear with no
code change.

Roughly **110 Avantis markets against 520 Variational listings, 37 Ondo, ~170 GRVT and 75
Pacifica → ~90 matched**, spanning crypto, US equities, commodities, metals and (via
Pacifica) two FX pairs. Avantis FX had no counterpart until Pacifica listed `EURUSD` and
`USDJPY`; the rest of the FX book is still unhedgeable here.

Ondo overlaps Avantis on 28 tickers by exact name, and overrides pick up `WTI`, `BRENT` and
`GOOGL` on top, so 31 of Ondo's 37 markets are hedgeable. Its remaining six — `US500`,
`US100`, `DRAM`, `SMSN`, `NBIS`, `ORCL` — have no Avantis pair, and since Avantis anchors
every trade they are unusable here.

**Ondo widens no part of the universe.** Variational already lists all 90 matched assets,
including every one of Ondo's 31, so Ondo adds no row that did not exist before — it only
competes on rate for rows Variational was already covering. Its value is entirely in winning
those head-to-head, and in staying quoted when Variational zeroes out.

**Pacifica does.** It is the only hedge that lists SK Hynix (`SKHY` → `SKHYNIX`) and the only
one that covers any Avantis FX (`EURUSD`, `USDJPY`). `kBONK` / `kPEPE` / `kSHIB` overlap
Variational's 1000x book.

Only genuine naming disagreements need an entry in `HEDGE_OVERRIDES`, which is keyed by
venue because the two disagree with Avantis in different places:

| Avantis | Variational | Ondo | Pacifica | Why |
|---|---|---|---|---|
| `BONK`, `PEPE`, `SHIB` | `1000BONK`, `1000PEPE` | — | `kBONK`, `kPEPE`, `kSHIB` | 1000x contract denomination. Funding is a percentage of notional, so the rate is unaffected and the match is exact. |
| `SKHY` | — | — | `SKHYNIX` | Same name, truncated ticker on Avantis. |
| `SPY` | `US500` | `SPY` | — | Despite the ticker, Variational's `US500` is the SPDR S&P 500 ETF itself, marked ~742 like the ETF. Not to be confused with Variational's `SPX`, which is **SPX6900, a memecoin**. Ondo lists the ETF under its own ticker. Pacifica's `SP500` is the index, not the ETF, so it is left unmatched. |
| `BB` | `BBX` | `BB` | — | BlackBerry. Variational suffixes the ticker. |
| `WTIU6`, `WTIM6`, `BRENTV6` | `CL`, `BZ` | `WTI`, `BRENT` | `CL` (WTI only) | Avantis prices dated futures expiries; hedge venues quote generic crude. Pacifica has no Brent. |
| `PUMP` | `PUMPFUN` | — | `PUMP` | Same token. |
| `GOOG` | `GOOGL` | `GOOGL` | `GOOGL` | **Different share class.** Near-identical price, but not the same instrument. |

The GOOG and dated-crude rows are flagged in the UI via `MATCH_CAVEATS` rather than
silently treated as exact. `SKHY`/`SKHYNIX` is the same name, so it is not.

## Three gates

Only three things keep a market off the board, and none of them is a liquidity opinion.

1. **Avantis trading calendar.** Each feed carries `is_open`. Equities, metals, commodities
   and FX are shut outside market hours; crypto is always open. Avantis is on every pair, so
   this gate alone empties most of the board on a weekend.
2. **Stale-zero funding.** A closed Variational market reports `funding_rate` of exactly `0`,
   which reads as free carry if taken literally. Ondo publishes a real zero for a different
   reason — it voids the hour whenever its premium sampler drops more than 6 minutes of data —
   and separately flags a market it will not trade at all as `disabled`. Both are missing
   data, and an asset is only withheld when *every* venue quoting it is stale.
3. **No edge.** If the best Avantis-anchored direction across every live hedge still has
   negative net carry, there is no trade — the profitable side would need Avantis to be the
   earning leg, which it never is. Withheld rather than ranked, so everything listed pays.

Everything that pays lands in **one table, sorted by Avantis 24h volume descending**, ties
broken by rate. Once a pair is known to pay, the open question is how much size it can take,
and Avantis is usually the binding side: it is on every pair and is much the smaller venue.
On a typical day roughly half its markets trade nothing at all, and those show a dash rather
than a number — the rate is real, the depth behind it is not. The hedge leg has its own
volume column on the same log scale, so the two meters can be read against each other to see
which leg actually caps the pair. Every column is click-sortable, and the board filters by
asset class and by hedge venue.

When two venues quote the same carry to the basis point, the deeper one wins the row.

Expect most of the universe to be withheld on a weekend — only crypto trades, so equities,
metals and commodities all drop out. That is correct behaviour, not a failure.

## Running it

```bash
npm install
npm run dev         
```

```bash
npm run build && npm start   # production
npm run typecheck            # tsc --noEmit
```

## Deploying

Vercel auto-detects Next.js, so there is nothing to configure:

```bash
npx vercel --prod
```

**No environment variables are required.** Every venue endpoint is public and
unauthenticated.

## Routes

| Route | Returns | Revalidate |
|---|---|---|
| `/` | Scanner UI | 120s |
| `/api/funding` | Raw funding per matched market, every venue | 120s |
| `/api/opportunities` | Every paying pair, volume descending, plus the withheld list | 120s |

## Data sources

Unauthenticated batch calls per scan, each returning every market on the venue:

| Venue | Endpoint | Supplies |
|---|---|---|
| Avantis | `socket-api-pub.avantisfi.com/socket-api/v1/data?override=true` | Borrow fee, OI, trading calendar |
| Avantis | `api.avantisfi.com/v1/history/analytics/daily-volumes-by-pair/1/true` | 24h volume, by pair index |
| Variational | `omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats` | Funding, volume, OI |
| Ondo | `api.ondoperps.xyz/v1/perps/contracts` | Funding, volume, OI, underlying-market state |
| Ondo | `api.ondoperps.xyz/v1/markets` | Long names only |
| GRVT | `market-data.grvt.io/full/v1/all_instruments` + `/ticker` | Funding, volume, OI |
| Pacifica | `api.pacifica.fi/api/v1/info/prices` | Funding, volume, OI |

The Avantis socket-api feed carries no volume at all, hence the second Avantis call. It is
joined on `pairIndex`, and a pair missing from its payload traded nothing — which is the
common case. Because that volume gates the whole ranking, a failure there is raised as a
venue error rather than degraded into a table of zeroes. The second Ondo call is the
opposite: it only supplies row labels, so a failure there is swallowed and the squashed
`displayName` is used instead.

Note the Variational host: `omni.variational.io` is behind Cloudflare and needs TLS
impersonation, but `omni-client-api.prod...` answers a plain `fetch`. Ondo has no such split.

### Unit conversions

| Venue | Field | Native unit | To daily % |
|---|---|---|---|
| Avantis | `marginFee.{long,short}` | percent / hour | `× 24` |
| Variational | `funding_rate` | **annualized fraction** | `× 100 / 365` |
| Ondo | `nextFundingRate` | fraction / hour | `× 24 × 100` |
| Pacifica | `next_funding` | fraction / hour | `× 24 × 100` |

Sign convention everywhere: **positive means the trader pays.**

These units are pinned by round numbers in the feeds rather than by documentation alone:

- Avantis `marginFee` × 24 × 365 lands exactly on `storagePairParams.minBorrowFee` /
  `maxBorrowFee`, which are the 15%–100% APR bounds. BTC sits at the 15% floor.
- Variational `funding_rate` is **not** a per-interval percent, despite
  `funding_interval_s` sitting next to it. Around 300 listings sit at exactly `0.1095`,
  which is 10.95% a year — the standard 0.01%-per-8h baseline — and they sit there on both
  the 4h and the 8h schedule, which only works if the number is already annualized. The app
  UI agrees: BTC at `0.04988` displays as `0.0045%` per 8h, and
  `0.04988 × 28800 / 31_536_000 = 0.004555%`.
- Ondo settles hourly on UTC hour boundaries and publishes the hourly fraction directly. A
  market resting on its oracle prints exactly `0.0000125`, which is the same 0.03%/day
  interest baseline, and the Ondo UI shows that market's rate as `0.00125%` with a countdown
  to the top of the hour.
- Pacifica is the same hourly fraction, same `0.0000125` oracle print, same 0.03%/day
  baseline. The published formula is `(premium + clamp(0.01% − premium, ±0.05%)) / 8`.
  `next_funding` is the TWAP the UI shows for the hour now running; `funding` is the hour
  that already settled. Open interest in that payload is in base units despite the docs
  saying USD, so the adapter multiplies by mark.

`funding_interval_s` is therefore the settlement cadence only. Scaling by it overstates
funding by 10.95× on 8h markets and 21.9× on 4h ones, which does not merely inflate the
APRs, it reorders the board.

Ondo's rate already carries the venue's /8 premium smoothing, so it must not be divided
again: the published number is the amount that actually changes hands this hour.

### Ondo and Pacifica price funding through a closed underlying

Ondo and Pacifica both trade 24/7 and keep charging funding when the underlying cash market
is shut, deriving the premium from their own books instead of an oracle — which can produce
a much larger rate. Ondo records this as `isClosed`; Pacifica does not flag it. Neither is a
gate, because the Avantis calendar has already withheld the pair by the time it matters. It
is worth re-sampling rates during US cash hours before treating a weekend print as
representative.

## Not modelled

Execution cost, spread, open/close fees, leverage, liquidation risk, basis divergence between
the two marks, and Avantis open-interest caps. Because there is no cost term there is no
breakeven — net edge is linear in holding period, so ranking by daily carry is the same as
ranking at any horizon.

Every APR is a snapshot rate annualized flat. That is a projection, not a backtest, and a
four-figure APR on an hourly-resetting rate should be read as a lead to verify rather than a
signal to size. Avantis and Variational publish no funding history at all; Ondo does, at
`/v1/perps/funding_rate_history`, which is the obvious way to put a realized average behind
the projection later.

## Layout

```
app/
  page.tsx                 scanner (server component, calls scan() directly)
  actions.ts               refresh server action
  api/funding/route.ts
  api/opportunities/route.ts
lib/
  types.ts                 ANCHOR_VENUE, HEDGE_VENUES, shared shapes
  symbols.ts               symbol parsing, per-venue overrides, match caveats
  strategy.ts              carry math + scan orchestration
  format.ts                number formatting
  venues/avantis.ts        anchor adapter (all pairs)
  venues/avantisVolume.ts  24h volume by pair index
  venues/variational.ts    hedge adapter (all listings)
  venues/ondo.ts           hedge adapter (all contracts)
  venues/grvt.ts           hedge adapter (all perps)
  venues/pacifica.ts       hedge adapter (all perps)
components/
  LeadCard.tsx             top-ranked pair, both legs spelled out
  OpportunityTable.tsx     ranked table: sort, class/venue filters, cost-vs-earn bar
  WithheldPanel.tsx        withheld assets grouped by reason
  Venue.tsx                venue colour key
  RefreshButton.tsx
```

Venue identity is carried by colour and used for nothing else: **Avantis violet**,
**Variational blue**, **Ondo teal**, **GRVT amber**, **Pacifica sky**. Sign is carried
separately by green (earn) and red (pay), so a row never has to be decoded twice. The `Cost vs earn` column draws the Avantis
fee left of a zero axis and the hedge funding right of it in that hedge's own colour, with a
tick at the net — a pair pays exactly when its tick sits right of the axis. The hedge column
header itself is left neutral, since the column is shared.

`lib/strategy.ts` splits into pure functions (`netCarryBps`, `bestPair`, `bestAcrossHedges`)
and one orchestrator (`scan`), so the math is testable without a network.

### Adding another hedge venue

Write a fetcher returning `Map<string, HedgeMarket>` keyed by the Avantis base symbol, add
the id to `HEDGE_VENUES`, and wire it into `HEDGE_FETCHERS`. Overrides, caveats, colour and
filters are all keyed off that id, so the compiler will point at whatever is left.
