import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const TICKERS_API = "https://api.bybit.com/v5/market/tickers?category=linear";

interface BybitTicker {
  symbol?: string;
  fundingRate?: string | number;
  fundingIntervalHour?: string | number;
  turnover24h?: string | number;
  openInterestValue?: string | number;
  deliveryTime?: string | number;
}

interface BybitTickersPayload {
  retCode?: number;
  result?: { list?: BybitTicker[] };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

/**
 * Every Bybit linear USDT perpetual, keyed by base symbol.
 *
 * `/v5/market/tickers?category=linear` returns funding rate, interval hours,
 * 24h USD turnover, and USD open interest for all linear contracts in a single
 * call. Dated futures carry a non-zero `deliveryTime` and are skipped.
 *
 * `fundingRate` is a decimal fraction per `fundingIntervalHour` (e.g. `0.0001`
 * for 0.01% per 8h), positive meaning longs pay shorts.
 */
export async function fetchBybitMarkets(): Promise<Map<string, HedgeMarket>> {
  const payload = await fetchJson<BybitTickersPayload>(TICKERS_API);
  const list = payload.result?.list ?? [];

  const out = new Map<string, HedgeMarket>();

  for (const t of list) {
    if (!t?.symbol) continue;
    const sym = String(t.symbol).toUpperCase();
    if (!sym.endsWith("USDT")) continue;
    // Dated futures have deliveryTime !== "0".
    if (t.deliveryTime && String(t.deliveryTime) !== "0") continue;
    if (t.fundingRate === "" || t.fundingRate === undefined) continue;

    const base = sym.slice(0, -4);
    if (!base) continue;

    const intervalHours = num(t.fundingIntervalHour) || 8;
    const rateFrac = num(t.fundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / intervalHours) * 100;

    out.set(base, {
      venue: "bybit",
      asset: base,
      market: sym,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalHours * 3600,
      stale: rateFrac === 0,
      volume24hUsd: num(t.turnover24h),
      openInterestUsd: num(t.openInterestValue),
    });
  }

  return out;
}
