import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BASE = "https://prod-gateway.antarctic.exchange/futures/fapi/market/v1/public";
const SYMBOL_LIST_API = `${BASE}/symbol/list`;
const AGG_TICKERS_API = `${BASE}/q/agg-tickers`;
const FUNDING_RATE_API = `${BASE}/q/funding-rate`;
const OPEN_INTEREST_API = `${BASE}/q/open-interest`;

const AE_HEADERS: Record<string, string> = {
  "ae-time-zone": "UTC+00:00",
  "ae-market-zone": "H24",
  "ae-platform": "WEB",
  source: "web",
};

interface AntarcticEnvelope<T> {
  code?: number;
  data?: T;
}

interface AntarcticSymbol {
  symbol?: string;
  baseCoin?: string;
  quoteCoin?: string;
  contractType?: string;
  tradeSwitch?: boolean;
  baseCoinName?: string;
}

interface AntarcticAggTicker {
  s?: string;
  v?: string | number;
}

interface AntarcticFundingRate {
  symbol?: string;
  fundingRate?: string | number;
  nextCollectionTime?: number;
}

interface AntarcticOpenInterest {
  symbol?: string;
  openInterestUsd?: string | number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Standard 8-hour funding cadence across all Antarctic perpetuals (28,800s).
const INTERVAL_HOURS = 8;
const HOURS_PER_DAY = 24;

/**
 * Every Antarctic Exchange USDT perpetual (`*_usdt`), keyed by uppercase base symbol.
 *
 * Antarctic lists crypto, US equities (`NVDA`, `AAPL`, `TSLA`, `AMZN`, `GOOGL`,
 * `SNDK`, `MSTR`, `SPY`, `QQQ`), metals (`GOLD`, `SILVER`) and crude (`CL`).
 *
 * `/q/agg-tickers` (requires `ae-market-zone: H24` and `ae-time-zone: UTC+00:00`
 * headers) returns 24h USD notional volume (`v`) for all listings in one call.
 * `/q/funding-rate` returns the current 8-hour funding rate as a decimal fraction
 * (e.g. `0.0001` = 0.01% per 8h), positive meaning longs pay shorts.
 */
export async function fetchAntarcticMarkets(): Promise<Map<string, HedgeMarket>> {
  const [symbolsEnv, tickersEnv] = await Promise.all([
    fetchJson<AntarcticEnvelope<AntarcticSymbol[]>>(SYMBOL_LIST_API, {
      headers: AE_HEADERS,
    }),
    fetchJson<AntarcticEnvelope<AntarcticAggTicker[]>>(AGG_TICKERS_API, {
      headers: AE_HEADERS,
    }).catch(() => ({ data: [] }) as AntarcticEnvelope<AntarcticAggTicker[]>),
  ]);

  const symbols = (symbolsEnv.data ?? []).filter(
    (s) =>
      s?.symbol &&
      s.baseCoin &&
      s.tradeSwitch !== false &&
      (!s.contractType || s.contractType === "PERPETUAL") &&
      String(s.quoteCoin ?? "usdt").toLowerCase() === "usdt",
  );

  const volumeBySymbol = new Map<string, number>();
  for (const t of tickersEnv.data ?? []) {
    if (t?.s) {
      volumeBySymbol.set(String(t.s).toLowerCase(), num(t.v));
    }
  }

  const perSymbol = await Promise.allSettled(
    symbols.map(async (s) => {
      const sym = String(s.symbol).toLowerCase();
      const [frEnv, oiEnv] = await Promise.all([
        fetchJson<AntarcticEnvelope<AntarcticFundingRate>>(
          `${FUNDING_RATE_API}?symbol=${encodeURIComponent(sym)}`,
          { headers: AE_HEADERS, timeoutMs: 6000, retries: 0 },
        ),
        fetchJson<AntarcticEnvelope<AntarcticOpenInterest>>(
          `${OPEN_INTEREST_API}?symbol=${encodeURIComponent(sym)}`,
          { headers: AE_HEADERS, timeoutMs: 6000, retries: 0 },
        ).catch(() => null),
      ]);
      return { s, sym, fr: frEnv.data, oi: oiEnv?.data };
    }),
  );

  const out = new Map<string, HedgeMarket>();

  for (const res of perSymbol) {
    if (res.status !== "fulfilled" || !res.value.fr) continue;
    const { s, sym, fr, oi } = res.value;
    const base = String(s.baseCoin).toUpperCase();
    if (!base) continue;

    const rateFrac = num(fr.fundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / INTERVAL_HOURS) * 100;

    out.set(base, {
      venue: "antarctic",
      asset: base,
      market: sym.toUpperCase(),
      name: s.baseCoinName ? String(s.baseCoinName) : base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: INTERVAL_HOURS * 3600,
      // Closed RWA/equity markets report 0 funding rate outside market hours.
      stale: rateFrac === 0,
      volume24hUsd: volumeBySymbol.get(sym) ?? 0,
      openInterestUsd: num(oi?.openInterestUsd),
    });
  }

  return out;
}
