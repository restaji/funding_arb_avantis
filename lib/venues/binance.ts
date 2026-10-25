import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const PREMIUM_API = "https://fapi.binance.com/fapi/v1/premiumIndex";
const FUNDING_INFO_API = "https://fapi.binance.com/fapi/v1/fundingInfo";
const TICKER_24H_API = "https://fapi.binance.com/fapi/v1/ticker/24hr";

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

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

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
  const [premiums, fundingInfos, tickers] = await Promise.all([
    fetchJson<BinancePremium[]>(PREMIUM_API),
    fetchJson<BinanceFundingInfo[]>(FUNDING_INFO_API).catch(() => [] as BinanceFundingInfo[]),
    fetchJson<BinanceTicker24h[]>(TICKER_24H_API).catch(() => [] as BinanceTicker24h[]),
  ]);

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
