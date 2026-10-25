import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BINANCE_BASES = [
  "https://fapi.binance.com/fapi/v1",
  "https://www.binance.com/fapi/v1",
];

const HL_INFO_API = "https://api.hyperliquid.xyz/info";
const LIGHTER_RATES_API = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";

interface BinancePremium {
  symbol?: string;
  lastFundingRate?: string | number;
  nextFundingTime?: number;
}

interface BinanceFundingInfo {
  symbol?: string;
  fundingIntervalHours?: number;
}

interface BinanceTicker24h {
  symbol?: string;
  quoteVolume?: string | number;
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

/** Normalize Hyperliquid `k`-prefixed 1000x tickers (`kBONK` -> `1000BONK`) to Binance naming. */
function toBinanceBase(coin: string): string {
  const upper = coin.toUpperCase();
  if (
    upper.startsWith("K") &&
    ["KBONK", "KPEPE", "KSHIB", "KFLOKI", "KLUNC", "KDOGS", "KNEIRO"].includes(upper)
  ) {
    return `1000${upper.slice(1)}`;
  }
  return upper;
}

/**
 * Fallback when `fapi.binance.com` returns HTTP 451 (US/AWS geo-block on Vercel).
 *
 * Both Hyperliquid (`predictedFundings` -> `BinPerp`) and Lighter
 * (`/api/v1/funding-rates` -> `exchange === "binance"`) mirror Binance's live
 * USDT-perp funding rates directly from non-geoblocked endpoints:
 * - Hyperliquid `BinPerp` provides the exact per-interval `fundingRate` and
 *   `fundingIntervalHours` (1h, 2h, 4h, or 8h).
 * - Lighter `exchange === "binance"` provides `rate` pre-normalized to an 8h
 *   decimal fraction (`longDailyPct = rate * 3 * 100`).
 */
async function fetchBinanceFallback(): Promise<Map<string, HedgeMarket>> {
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
    const binEntry = venues.find(([name]) => name === "BinPerp")?.[1];
    if (!binEntry || !binEntry.fundingIntervalHours) continue;

    const base = toBinanceBase(coin);
    const intervalHours = binEntry.fundingIntervalHours || 8;
    const rateFrac = num(binEntry.fundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / intervalHours) * 100;

    out.set(base, {
      venue: "binance",
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
    if (r?.exchange !== "binance" || !r.symbol) continue;
    const base = String(r.symbol).toUpperCase();
    if (out.has(base)) continue;

    const rate8hFrac = num(r.rate);
    // Skip zero-rate placeholders on Lighter for non-Binance RWA symbols.
    if (rate8hFrac === 0) continue;
    const longDailyPct = rate8hFrac * 3 * 100;

    out.set(base, {
      venue: "binance",
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
    throw new Error("Binance fapi HTTP 451 (geo-blocked) and fallback empty");
  }

  return out;
}

/**
 * Every Binance USD-M perpetual (`*USDT`), keyed by base symbol.
 *
 * `lastFundingRate` on `/fapi/v1/premiumIndex` is the per-interval decimal
 * fraction (e.g. `0.0001` = 0.01% per interval). Most contracts settle every
 * 8h; contracts with a non-default cadence (4h, 2h, 1h) appear in
 * `/fapi/v1/fundingInfo` with `fundingIntervalHours`.
 *
 * Delisted or settling contracts report `nextFundingTime === 0` and are skipped.
 */
export async function fetchBinanceMarkets(): Promise<Map<string, HedgeMarket>> {
  let premiums: BinancePremium[] | null = null;
  let fundingInfos: BinanceFundingInfo[] = [];
  let tickers: BinanceTicker24h[] = [];

  for (const baseApi of BINANCE_BASES) {
    try {
      const [p, fi, tk] = await Promise.all([
        fetchJson<BinancePremium[]>(`${baseApi}/premiumIndex`, { retries: 0 }),
        fetchJson<BinanceFundingInfo[]>(`${baseApi}/fundingInfo`, { retries: 0 }).catch(
          () => [] as BinanceFundingInfo[],
        ),
        fetchJson<BinanceTicker24h[]>(`${baseApi}/ticker/24hr`, { retries: 0 }).catch(
          () => [] as BinanceTicker24h[],
        ),
      ]);
      if (Array.isArray(p) && p.length > 0) {
        premiums = p;
        fundingInfos = fi;
        tickers = tk;
        break;
      }
    } catch {
      // Try next mirror or geo-block fallback.
    }
  }

  if (!premiums) {
    return fetchBinanceFallback();
  }

  const intervalBySymbol = new Map<string, number>();
  for (const info of fundingInfos ?? []) {
    if (info?.symbol && info.fundingIntervalHours && info.fundingIntervalHours > 0) {
      intervalBySymbol.set(info.symbol.toUpperCase(), info.fundingIntervalHours);
    }
  }

  const volumeBySymbol = new Map<string, number>();
  for (const t of tickers ?? []) {
    if (t?.symbol) {
      volumeBySymbol.set(t.symbol.toUpperCase(), num(t.quoteVolume));
    }
  }

  const out = new Map<string, HedgeMarket>();

  for (const p of premiums ?? []) {
    if (!p?.symbol) continue;
    const sym = String(p.symbol).toUpperCase();
    if (!sym.endsWith("USDT")) continue;
    // Delisted or non-perpetual contracts have no upcoming funding settlement.
    if (!p.nextFundingTime || p.nextFundingTime <= 0) continue;

    const base = sym.slice(0, -4);
    if (!base) continue;

    const intervalHours = intervalBySymbol.get(sym) ?? 8;
    const rateFrac = num(p.lastFundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / intervalHours) * 100;

    out.set(base, {
      venue: "binance",
      asset: base,
      market: sym,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalHours * 3600,
      stale: rateFrac === 0,
      volume24hUsd: volumeBySymbol.get(sym) ?? 0,
      openInterestUsd: 0,
    });
  }

  return out;
}
