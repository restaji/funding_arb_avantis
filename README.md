# Avantis × Variational — Funding Carry

A Vercel-deployable scanner for delta-neutral funding carry between **Avantis** and
**Variational**, across every market the two venues have in common.

Every pair is Avantis-anchored: Avantis sits on one leg, Variational on the other. Only
funding is modelled — execution cost, spread, and fees are deliberately out of scope.

For the wider multi-venue design this was narrowed down from, see
[`funding_strategy.md`](./funding_strategy.md).

## The one thing to understand

Avantis charges a **borrow fee to the LPs on both sides**. A short does not receive the long
fee, it pays the short fee. So the Avantis leg is always a cost, and:

```
netCarry > 0   ⟺   variationalRate < -avantisRate
```

Variational has to out-earn the Avantis fee on its own. Avantis never generates edge here —
it is the position being financed, and the app's job is to find where financing it is cheap.

That fee starts at **15% a year** and runs to 100%, while most Variational markets sit at the
10.95% baseline. So the honest expectation is a nearly empty board: a pair only appears when
Variational funding is strongly negative against a low-fee Avantis pair. Two or three
candidates is a normal day, not a bug.

## The asset universe is discovered, not hardcoded

Avantis publishes a Pyth-style symbol on every pair (`feed.attributes.symbol`, e.g.
`Crypto.BTC/USD`), so the tradeable set is computed at runtime as the intersection of the two
venues' listings. New markets on either side appear with no code change.

Roughly **110 Avantis markets × 516 Variational listings → ~89 matched**, spanning crypto,
US equities, commodities and metals. Avantis FX has no Variational counterpart at all, so
those ~15 pairs are permanently unhedgeable here.

Only genuine naming disagreements need an entry in `VARIATIONAL_OVERRIDES`:

| Avantis | Variational | Why |
|---|---|---|
| `BONK`, `PEPE` | `1000BONK`, `1000PEPE` | 1000x contract denomination. Funding is a percentage of notional, so the rate is unaffected and the match is exact. |
| `SPY` | `US500` | Despite the ticker, `US500` is Variational's listing of the SPDR S&P 500 ETF itself, marked ~742 like the ETF. Not to be confused with Variational's `SPX`, which is **SPX6900, a memecoin**. |
| `BB` | `BBX` | BlackBerry. Variational suffixes the ticker. |
| `WTIU6`, `WTIM6`, `BRENTV6` | `CL`, `BZ` | Avantis prices dated futures expiries, Variational quotes generic crude. |
| `PUMP` | `PUMPFUN` | Same token. |
| `GOOG` | `GOOGL` | **Different share class.** Near-identical price, but not the same instrument. |

The last two rows are flagged in the UI via `MATCH_CAVEATS` rather than silently treated as
exact.

## Three gates

Only three things keep a market off the board, and none of them is a liquidity opinion.

1. **Avantis trading calendar.** Each feed carries `is_open`. Equities, metals, commodities
   and FX are shut outside market hours; crypto is always open.
2. **Stale-zero funding.** A closed Variational market reports `funding_rate` of exactly `0`,
   which reads as free carry if taken literally. Treated as missing data and withheld.
3. **No edge.** If the better of the two Avantis-anchored directions still has negative net
   carry, there is no trade — the profitable side would need Avantis to be the earning leg,
   which it never is. Withheld rather than ranked, so everything listed pays.

Everything that pays lands in **one table, sorted by Avantis 24h volume descending**, ties
broken by rate. Once a pair is known to pay, the open question is how much size it can take,
and Avantis is the binding side: it is on every pair and is much the smaller venue. On a
typical day roughly half its markets trade nothing at all, and those show a dash rather than
a number — the rate is real, the depth behind it is not. Every column is click-sortable if
you want the rate view instead.

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

**No environment variables are required.** Both venue endpoints are public and
unauthenticated.

## Routes

| Route | Returns | Revalidate |
|---|---|---|
| `/` | Scanner UI | 120s |
| `/api/funding` | Raw funding per matched market, both venues | 120s |
| `/api/opportunities` | Every paying pair, volume descending, plus the withheld list | 120s |

## Data sources

Three unauthenticated batch calls per scan, each returning every market on the venue:

| Venue | Endpoint | Supplies |
|---|---|---|
| Avantis | `socket-api-pub.avantisfi.com/socket-api/v1/data?override=true` | Borrow fee, OI, trading calendar |
| Avantis | `api.avantisfi.com/v1/history/analytics/daily-volumes-by-pair/1/true` | 24h volume, by pair index |
| Variational | `omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats` | Funding, volume, OI |

The socket-api feed carries no volume at all, hence the second Avantis call. It is joined on
`pairIndex`, and a pair missing from its payload traded nothing — which is the common case.
Because that volume gates the whole ranking, a failure there is raised as a venue error
rather than degraded into a table of zeroes.

Note the Variational host: `omni.variational.io` is behind Cloudflare and needs TLS
impersonation, but `omni-client-api.prod...` answers a plain `fetch`.

### Unit conversions

| Venue | Field | Native unit | To daily % |
|---|---|---|---|
| Avantis | `marginFee.{long,short}` | percent / hour | `× 24` |
| Variational | `funding_rate` | **annualized fraction** | `× 100 / 365` |

Sign convention everywhere: **positive means the trader pays.**

Both units are pinned by round numbers in the feeds rather than by documentation:

- Avantis `marginFee` × 24 × 365 lands exactly on `storagePairParams.minBorrowFee` /
  `maxBorrowFee`, which are the 15%–100% APR bounds. BTC sits at the 15% floor.
- Variational `funding_rate` is **not** a per-interval percent, despite
  `funding_interval_s` sitting next to it. Around 300 listings sit at exactly `0.1095`,
  which is 10.95% a year — the standard 0.01%-per-8h baseline — and they sit there on both
  the 4h and the 8h schedule, which only works if the number is already annualized. The app
  UI agrees: BTC at `0.04988` displays as `0.0045%` per 8h, and
  `0.04988 × 28800 / 31_536_000 = 0.004555%`.

`funding_interval_s` is therefore the settlement cadence only. Scaling by it overstates
funding by 10.95× on 8h markets and 21.9× on 4h ones, which does not merely inflate the
APRs, it reorders the board.

## Not modelled

Execution cost, spread, open/close fees, leverage, liquidation risk, basis divergence between
the two marks, and Avantis open-interest caps. Because there is no cost term there is no
breakeven — net edge is linear in holding period, so ranking by daily carry is the same as
ranking at any horizon.

Neither venue publishes funding history, so every APR is a snapshot rate annualized flat.
That is a projection, not a backtest, and a four-figure APR on an hourly-resetting rate should
be read as a lead to verify rather than a signal to size.

## Layout

```
app/
  page.tsx                 scanner (server component, calls scan() directly)
  actions.ts               refresh server action
  api/funding/route.ts
  api/opportunities/route.ts
lib/
  types.ts                 ANCHOR_VENUE, shared shapes
  symbols.ts               symbol parsing, overrides, match caveats
  strategy.ts              carry math + scan orchestration
  format.ts                number formatting
  venues/avantis.ts        anchor adapter (all pairs)
  venues/avantisVolume.ts  24h volume by pair index
  venues/variational.ts    hedge adapter (all listings)
components/
  LeadCard.tsx             top-ranked pair, both legs spelled out
  OpportunityTable.tsx     ranked table: sort, class filter, cost-vs-earn bar
  WithheldPanel.tsx        withheld assets grouped by reason
  Venue.tsx                venue colour key
  RefreshButton.tsx
```

Two colours carry venue identity and are used for nothing else: **Avantis violet**,
**Variational blue**. Sign is carried separately by green (earn) and red (pay), so a row
never has to be decoded twice. The `Cost vs earn` column draws the Avantis fee left of a
zero axis and the Variational funding right of it, with a tick at the net — a pair pays
exactly when its tick sits right of the axis.

`lib/strategy.ts` splits into pure functions (`netCarryBps`, `bestPair`) and one orchestrator
(`scan`), so the math is testable without a network.
