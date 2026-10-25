import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BASE = "https://mainnet.zklighter.elliot.ai/api/v1";
const BOOKS_API = `${BASE}/orderBookDetails`;
const RATES_API = `${BASE}/funding-rates`;

interface LighterBookDetail {
  symbol?: string;
  market_id?: number;
  market_type?: string;
  status?: string;
  daily_quote_token_volume?: number | string;
  open_interest_usd?: number | string;
}

interface LighterBooksPayload {
  order_book_details?: LighterBookDetail[];
}

interface LighterFundingRate {
  market_id?: number;
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

/**
 * Every Lighter perpetual, keyed by uppercase symbol.
 *
 * Lighter settles funding hourly, but `/api/v1/funding-rates` (filtered to
 * `exchange === "lighter"`) publishes `rate` as an **8-hour decimal fraction**
 * (verified against `/api/v1/fundings?resolution=1h`, where the 1h settled
 * percentage equals `rate / 8 * 100`, e.g. BTC `rate = 0.000096` -> `0.0012%/h`,
 * the standard 0.01%/8h baseline).
 *
 * Daily % is therefore `rate * 3 * 100` (three 8h periods per day), positive
 * meaning longs pay shorts. Volume (`daily_quote_token_volume`) and OI
 * (`open_interest_usd`) come from `/api/v1/orderBookDetails`.
 */
export async function fetchLighterMarkets(): Promise<Map<string, HedgeMarket>> {
  const [booksPayload, ratesPayload] = await Promise.all([
    fetchJson<LighterBooksPayload>(BOOKS_API),
    fetchJson<LighterRatesPayload>(RATES_API),
  ]);

  const rateByMarketId = new Map<number, number>();
  const rateBySymbol = new Map<string, number>();

  for (const r of ratesPayload.funding_rates ?? []) {
    if (r?.exchange !== "lighter") continue;
    const rate8hFrac = num(r.rate);
    if (typeof r.market_id === "number") {
      rateByMarketId.set(r.market_id, rate8hFrac);
    }
    if (r.symbol) {
      rateBySymbol.set(String(r.symbol).toUpperCase(), rate8hFrac);
    }
  }

  const out = new Map<string, HedgeMarket>();

  for (const b of booksPayload.order_book_details ?? []) {
    if (!b?.symbol) continue;
    if (b.market_type && b.market_type !== "perp") continue;
    if (b.status && b.status !== "active") continue;

    const raw = String(b.symbol);
    const symbol = raw.toUpperCase();
    const rate8hFrac =
      (typeof b.market_id === "number" ? rateByMarketId.get(b.market_id) : undefined) ??
      rateBySymbol.get(symbol);

    if (rate8hFrac === undefined) continue;

    // 8h decimal fraction -> daily % (x 3 x 100).
    const longDailyPct = rate8hFrac * 3 * 100;

    out.set(symbol, {
      venue: "lighter",
      asset: symbol,
      market: raw,
      name: raw,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: 3600,
      stale: rate8hFrac === 0,
      volume24hUsd: num(b.daily_quote_token_volume),
      openInterestUsd: num(b.open_interest_usd),
    });
  }

  return out;
}
