import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BYBIT_TICKERS_APIS = [
  "https://api.bybit.com/v5/market/tickers?category=linear",
  "https://api.bytick.com/v5/market/tickers?category=linear",
  "https://api.bybitglobal.com/v5/market/tickers?category=linear",
];

const HL_INFO_API = "https://api.hyperliquid.xyz/info";
const LIGHTER_RATES_API = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";

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

interface HlPredictedEntry {
  fundingRate?: string | number;
  fundingIntervalHours?: number;
  nextFundingTime?: number;
}

type HlPredictedFundings = Array<
  [string, Array<[string, HlPredictedEntry | null]>]
>;

interface LighterFundingRate {
  exchange?: string;
  symbol?: string;
  rate?: number | string;
}

interface LighterRatesPayload {
  funding_rates?: LighterFundingRate[];
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

/** Normalize Hyperliquid/Lighter tickers to Bybit's native symbol conventions. */
function toBybitBase(coin: string): string {
  const upper = coin.toUpperCase();
  if (upper === "KSHIB" || upper === "1000SHIB") return "SHIB1000";
  if (upper === "PUMP") return "PUMPFUN";
  if (
    upper.startsWith("K") &&
    ["KBONK", "KPEPE", "KFLOKI", "KLUNC", "KDOGS", "KNEIRO"].includes(upper)
  ) {
    return `1000${upper.slice(1)}`;
  }
  return upper;
}

/**
 * Fallback when `api.bybit.com` / `api.bytick.com` return HTTP 403
 * (CloudFront US/AWS geo-block on Vercel).
 *
 * Both Hyperliquid (`predictedFundings` -> `BybitPerp`) and Lighter
 * (`/api/v1/funding-rates` -> `exchange === "bybit"`) mirror Bybit's live
 * linear USDT-perp funding rates from non-geoblocked endpoints.
 */
async function fetchBybitFallback(): Promise<Map<string, HedgeMarket>> {
  const [hlPredicted, lighterPayload] = await Promise.all([
    fetchJson<HlPredictedFundings>(HL_INFO_API, {
      method: "POST",
      body: { type: "predictedFundings" },
    }).catch(() => [] as HlPredictedFundings),
    fetchJson<LighterRatesPayload>(LIGHTER_RATES_API).catch(
      () => ({ funding_rates: [] }) as LighterRatesPayload,
    ),
  ]);

  const out = new Map<string, HedgeMarket>();

  for (const [coin, venues] of hlPredicted ?? []) {
    if (!coin || !Array.isArray(venues)) continue;
    const bybEntry = venues.find(([name]) => name === "BybitPerp")?.[1];
    if (!bybEntry || !bybEntry.fundingIntervalHours) continue;

    const base = toBybitBase(coin);
    const intervalHours = bybEntry.fundingIntervalHours || 8;
    const rateFrac = num(bybEntry.fundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / intervalHours) * 100;

    out.set(base, {
      venue: "bybit",
      asset: base,
      market: `${base}USDT`,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalHours * 3600,
      stale: rateFrac === 0,
      volume24hUsd: 0,
      openInterestUsd: 0,
    });
  }

  for (const r of lighterPayload.funding_rates ?? []) {
    if (r?.exchange !== "bybit" || !r.symbol) continue;
    const base = toBybitBase(String(r.symbol));
    if (out.has(base)) continue;

    const rate8hFrac = num(r.rate);
    if (rate8hFrac === 0) continue;
    const longDailyPct = rate8hFrac * 3 * 100;

    out.set(base, {
      venue: "bybit",
      asset: base,
      market: `${base}USDT`,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: 8 * 3600,
      stale: false,
      volume24hUsd: 0,
      openInterestUsd: 0,
    });
  }

  if (out.size === 0) {
    throw new Error("Bybit HTTP 403 (geo-blocked) and fallback empty");
  }

  return out;
}

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
  let list: BybitTicker[] | null = null;

  for (const url of BYBIT_TICKERS_APIS) {
    try {
      const payload = await fetchJson<BybitTickersPayload>(url, { retries: 0 });
      const items = payload.result?.list;
      if (Array.isArray(items) && items.length > 0) {
        list = items;
        break;
      }
    } catch {
      // Try next mirror or geo-block fallback.
    }
  }

  if (!list) {
    return fetchBybitFallback();
  }

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
