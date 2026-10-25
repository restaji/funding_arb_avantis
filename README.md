# Veranta × PerpDEX & CEX Hedge Venues — Funding Carry

A Vercel-deployable scanner for delta-neutral funding carry between **Veranta** (formerly
Avantis) and a hedge venue — **Hyperliquid**, **Lighter**, **Ostium**, **Variational**,
**Ondo Perps**, **GRVT**, **Pacifica**, **Jupiter**, **Antarctic**, **Binance**, **Bybit**,
**OKX**, or **Gate** — across every market they have in common.

Every pair is Veranta-anchored: Veranta sits on one leg, a hedge venue on the other. Each
asset is scored against every hedge venue that quotes it and only the best-paying pair
survives, so a venue can only add rows, never remove them. Only funding and borrow are
modelled — execution cost, spread, and open/close fees are deliberately out of scope.

For the wider multi-venue design this was narrowed down from, see
[`funding_strategy.md`](./funding_strategy.md).

## The one thing to understand

Veranta's holding rate per side is `fundingRate.{long,short} + marginFee.{long,short}` (what
the Veranta trade UI displays as **Net Rate (L/S)**): skew-driven trader-to-trader funding
plus the LP borrow fee. Sign convention everywhere is **positive = the trader pays**, so:

```
netCarryBps = -(longLegDailyPct + shortLegDailyPct) * 100
```

## The asset universe is discovered, not hardcoded

Veranta publishes a Pyth-style symbol on every pair (`feed.attributes.symbol`, e.g.
`Crypto.BTC/USD`), so the tradeable set is computed at runtime as the union, across hedge
venues, of the intersection with the Veranta book. New markets on any side appear with no
code change.

Only genuine naming disagreements or false ticker collisions need an entry in
`HEDGE_OVERRIDES`, which is keyed by venue:

| Veranta | Variational | Ondo | GRVT | Pacifica | Why |
|---|---|---|---|---|---|
| `BONK`, `PEPE`, `SHIB` | `1000BONK`, `1000PEPE` | — | — | `kBONK`, `kPEPE`, `kSHIB` | 1000x contract denomination. Funding is a percentage of notional, so the rate is unaffected and the match is exact. |
| `SKHY` | `SKHY` | `SKHY` | `SKHY` | `SKHYNIX` | Same name, truncated ticker on Veranta. |
| `SPY` | `US500` | `SPY` | `SPY` | — | Despite the ticker, Variational's `US500` is the SPDR S&P 500 ETF itself, marked ~760 like the ETF. Not to be confused with Variational's `SPX`, which is **SPX6900, a memecoin**. Ondo and GRVT list the ETF under its own ticker. Pacifica's `SP500` is the index, not the ETF, so it is left unmatched. |
| `BB`, `STX` | `BBX`, `STXX` | `BB`, — | `BBX`, `STXX` | — | BlackBerry and Seagate Technology. Variational and GRVT suffix the equity tickers (`STX` on Variational is Stacks, the crypto token). |
| `DASH` | *excluded* (`null`) | — | — | — | Veranta's `DASH` is DoorDash (`Equity.US.DASH/USD`); Variational's `DASH` is Dash (the cryptocurrency). |
| `CLLZ6`, `WTIV6`, `BRENTZ6` (any dated expiry) | `CL`, `BZ` | `WTI`, `BRENT` | `CL`, `BZ` | `CL` (WTI only) | Veranta prices dated futures expiries; hedge venues quote generic crude. Pacifica has no Brent. |
| `PUMP`, `LIT` | `PUMPFUN`, `LIGHTER` | `PUMP`, `LIT` | `PUMP`, `LIT` | `PUMP`, `LIT` | Same token. |
| `GOOG` | `GOOGL` | `GOOGL` | `GOOGL` | `GOOGL` | **Different share class.** Near-identical price, but not the same instrument. |

The `GOOG` and dated-crude rows are flagged in the UI via `MATCH_CAVEATS` rather than
silently treated as exact. `SKHY`/`SKHYNIX` is the same name, so it is not.

## Three gates

Only three things keep a market off the board, and none of them is a liquidity opinion.

1. **Veranta trading calendar.** Each feed carries `isOpen`. Equities, metals, commodities
   and FX are shut outside market hours; crypto is always open. Veranta is on every pair, so
   this gate alone empties most of the board on a weekend.
2. **Stale-zero funding.** A closed Variational or GRVT market reports `funding_rate` of
   exactly `0`, which reads as free carry if taken literally. Ondo publishes a real zero for
   a different reason — it voids the hour whenever its premium sampler drops more than 6
   minutes of data — and separately flags a market it will not trade at all as `disabled`.
   Both are missing data, and an asset is only withheld when *every* venue quoting it is
   stale.
3. **No edge.** If the best Veranta-anchored direction across every live hedge still has
   negative net carry, there is no trade. Withheld rather than ranked, so everything listed
   pays.

Everything that pays lands in **one table, sorted by Veranta 24h volume descending**, ties
broken by rate. Once a pair is known to pay, the open question is how much size it can take,
and Veranta is usually the binding side: it is on every pair and is much the smaller venue.
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
| `/` | Scanner UI | 60s |
| `/api/funding` | Raw funding per matched market, every venue | 60s |
| `/api/opportunities` | Every paying pair, volume descending, plus the withheld list | 60s |

## Data sources

Unauthenticated batch calls per scan, each returning every market on the venue:

| Venue | Endpoint | Supplies |
|---|---|---|
| Veranta | `data.veranta.xyz/v2/trading` | Funding, borrow fee, long/short OI, OI cap, trading calendar |
| Veranta | `api.veranta.xyz/v1/history/analytics/daily-volumes-by-pair/1/true` | 24h volume, by pair index |
| Hyperliquid | `POST api.hyperliquid.xyz/info` (`metaAndAssetCtxs`, main + `xyz` dex) | Funding, volume, OI |
| Lighter | `mainnet.zklighter.elliot.ai/api/v1/orderBookDetails` + `/funding-rates` | Funding, volume, OI |
| Ostium | `app.ostium.com/api/pairs` | Rollover + skew funding per block, OI |
| Variational | `omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats` | Funding, volume, OI |
| Ondo | `api.ondoperps.xyz/v1/perps/contracts` | Funding, volume, OI, underlying-market state |
| Ondo | `api.ondoperps.xyz/v1/markets` | Long names only |
| GRVT | `market-data.grvt.io/full/v1/all_instruments` + `/ticker` | Funding, volume, OI |
| Pacifica | `api.pacifica.fi/api/v1/info/prices` | Funding, volume, OI |
| Jupiter | `perps-api.jup.ag/v1/pool-info` + `/market-stats` + `/jlp-info` | Borrow rate (L/S), volume, OI |
| Antarctic | `prod-gateway.antarctic.exchange/futures/fapi/market/v1/public/symbol/list` + `/q/agg-tickers` + `/q/funding-rate` + `/q/open-interest` | Funding, volume, OI |
| Binance | `fapi.binance.com/fapi/v1/premiumIndex` + `/fundingInfo` + `/ticker/24hr` | Funding, interval, volume |
| Bybit | `api.bybit.com/v5/market/tickers?category=linear` | Funding, interval, volume, OI |
| OKX | `www.okx.com/api/v5/public/funding-rate?instId=ANY` + `/market/tickers` + `/open-interest` | Funding, interval, volume, OI |
| Gate | `api.gateio.ws/api/v4/futures/usdt/contracts` + `/tickers` | Funding, interval, volume, OI |

The Veranta trading feed carries funding, borrow fees, and long/short open interest but no
24h volume, hence the second Veranta call. It is joined on `pairIndex`, and a pair missing
from its payload traded nothing — which is the common case. Because that volume gates the
whole ranking, a failure there is raised as a venue error rather than degraded into a table
of zeroes. The second Ondo call is the opposite: it only supplies row labels, so a failure
there is swallowed and the squashed `displayName` is used instead.

Note the Variational host: `omni.variational.io` is behind Cloudflare and needs TLS
impersonation, but `omni-client-api.prod...` answers a plain `fetch`. Ondo has no such split.

### Unit conversions

| Venue | Field | Native unit | To daily % |
|---|---|---|---|
| Veranta | `(fundingRate + marginFee).{long,short}` | percent / hour | `× 24` |
| Hyperliquid | `ctx.funding` | fraction / hour | `× 24 × 100` |
| Lighter | `funding_rates.rate` (`exchange="lighter"`) | fraction / 8h | `× 3 × 100` |
| Ostium | `(±lastRolloverLongPure + brokerPremium + curFunding{Long,Short})` | 1e18 fraction / block | `÷ 1e18 × 345,600 × 100` |
| Variational | `funding_rate` | **annualized fraction** | `× 100 / 365` |
| Ondo | `nextFundingRate` | fraction / hour | `× 24 × 100` |
| GRVT | `funding_rate` | percent / interval | `× (24 / funding_interval_hours)` |
| Pacifica | `next_funding` | fraction / hour | `× 24 × 100` |
| Jupiter | `{long,short}BorrowRatePercent` | percent / hour (both sides pay) | `× 24` |
| Antarctic | `fundingRate` | fraction / 8h | `× 3 × 100` |
| Binance | `lastFundingRate` | fraction / interval | `× (24 / fundingIntervalHours) × 100` |
| Bybit | `fundingRate` | fraction / interval | `× (24 / fundingIntervalHour) × 100` |
| OKX | `fundingRate` | fraction / interval | `× (24 / intervalHours) × 100` |
| Gate | `funding_rate` | fraction / interval | `× (86,400 / funding_interval) × 100` |

Sign convention everywhere: **positive means the trader pays.**

These units are pinned by round numbers in the feeds rather than by documentation alone:

- Veranta's UI displays **Net Rate (L/S)** as `(fundingRate + marginFee) × horizon`, where
  both `fundingRate` and `marginFee` are percent per hour and positive means that side pays.
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
- GRVT `funding_rate` is a percent per `funding_interval_hours` (e.g. `0.01` on an 8h market
  or `0.005` on a 4h market, both equal to `0.03%/day`).
- Pacifica is the same hourly fraction as Ondo, same `0.0000125` oracle print, same 0.03%/day
  baseline. The published formula is `(premium + clamp(0.01% − premium, ±0.05%)) / 8`.
  `next_funding` is the TWAP the UI shows for the hour now running; `funding` is the hour
  that already settled. Open interest in that payload is in base units despite the docs
  saying USD, so the adapter multiplies by mark.

`funding_interval_s` on Variational is therefore the settlement cadence only. Scaling by it
overstates funding by 10.95× on 8h markets and 21.9× on 4h ones, which does not merely
inflate the APRs, it reorders the board.

Ondo's rate already carries the venue's /8 premium smoothing, so it must not be divided
again: the published number is the amount that actually changes hands this hour.

### Ondo and Pacifica price funding through a closed underlying

Ondo and Pacifica both trade 24/7 and keep charging funding when the underlying cash market
is shut, deriving the premium from their own books instead of an oracle — which can produce
a much larger rate. Ondo records this as `isClosed`; Pacifica does not flag it. Neither is a
gate, because the Veranta calendar has already withheld the pair by the time it matters. It
is worth re-sampling rates during US cash hours before treating a weekend print as
representative.

## Not modelled

Execution cost, spread, open/close fees, leverage, liquidation risk, basis divergence between
the two marks, and Veranta open-interest caps. Because there is no cost term there is no
breakeven — net edge is linear in holding period, so ranking by daily carry is the same as
ranking at any horizon.

Every APR is a snapshot rate annualized flat. That is a projection, not a backtest, and a
four-figure APR on an hourly-resetting rate should be read as a lead to verify rather than a
signal to size. Veranta and Variational publish no funding history at all; Ondo does, at
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
  venues/veranta.ts        anchor adapter (all pairs)
  venues/verantaVolume.ts  24h volume by pair index
  venues/variational.ts    hedge adapter (all listings)
  venues/ondo.ts           hedge adapter (all contracts)
  venues/grvt.ts           hedge adapter (all perps)
  venues/pacifica.ts       hedge adapter (all perps)
components/
  LeadCard.tsx             top-ranked pair, both legs spelled out
  OpportunityTable.tsx     ranked table: sort, class/venue filters, cost-vs-earn bar
  WithheldPanel.tsx        withheld assets grouped by reason
  Venue.tsx                venue colour key
  Tooltip.tsx              column-header readout, replaces the native title attribute
  RefreshButton.tsx
```

Venue identity is carried by colour and used for nothing else: **Veranta violet**,
**Variational blue**, **Ondo teal**, **GRVT amber**, **Pacifica sky**. Sign is carried
separately by green (earn) and red (pay), so a row never has to be decoded twice. The `Cost vs earn` column draws each leg's
cost left of a zero axis and income right of it in that venue's own colour, with a
tick at the net — a pair pays exactly when its tick sits right of the axis. The hedge column
header itself is left neutral, since the column is shared.

`lib/strategy.ts` splits into pure functions (`netCarryBps`, `bestPair`, `bestAcrossHedges`)
and one orchestrator (`scan`), so the math is testable without a network.

### Adding another hedge venue

Write a fetcher returning `Map<string, HedgeMarket>` keyed by the Veranta base symbol, add
the id to `HEDGE_VENUES`, and wire it into `HEDGE_FETCHERS`. Overrides, caveats, colour and
filters are all keyed off that id, so the compiler will point at whatever is left.
