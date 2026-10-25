import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BASE = "https://market-data.grvt.io/full/v1";
const INSTRUMENTS_API = `${BASE}/all_instruments`;
const TICKER_API = `${BASE}/ticker`;

/**
 * GRVT's whole Market Data API is POST-only, including reads — GET on any
 * endpoint here returns 405. Requests carry params as a JSON body, not a
 * query string.
 */
async function grvtPost<T>(url: string, body: unknown, retries = 0): Promise<T | null> {
  try {
    return await fetchJson<T>(url, {
      method: "POST",
      body,
      timeoutMs: 4500,
      retries,
    });
  } catch {
    return null;
  }
}

interface GrvtInstrument {
  instrument?: string;
  base?: string;
  quote?: string;
  kind?: string;
  status?: string;
  funding_interval_hours?: number;
}

interface GrvtInstrumentsPayload {
  result?: GrvtInstrument[];
}

interface GrvtTicker {
  instrument?: string;
  mark_price?: string;
  open_interest?: string;
  funding_rate?: string;
  buy_volume_24h_q?: string;
  sell_volume_24h_q?: string;
}

interface GrvtTickerPayload {
  result?: GrvtTicker;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;
const GRVT_CONCURRENCY = 25;

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Every GRVT perpetual, keyed by base symbol.
 *
 * There is no bulk ticker/funding endpoint — /full/v1/ticker only accepts one
 * `instrument` per call. If `allowedTickers` is provided (from the Veranta book),
 * we only fetch tickers that can actually match a Veranta pair rather than all
 * ~185 listings, cutting request volume by more than half.
 *
 * funding_rate is a percent already (not a fraction) settling every
 * funding_interval_hours, e.g. BTC sits at "0.01" (0.01%/8h), the standard
 * perp baseline. Daily is that scaled by 24/interval.
 */
export async function fetchGrvtMarkets(
  allowedTickers?: Set<string>,
): Promise<Map<string, HedgeMarket>> {
  const instrumentsPayload = await grvtPost<GrvtInstrumentsPayload>(
    INSTRUMENTS_API,
    { is_active: true },
    1,
  );
  const instruments = (instrumentsPayload?.result ?? []).filter((i) => {
    if (
      i.kind !== "PERPETUAL" ||
      (i.status && i.status !== "ACTIVE") ||
      !i.instrument ||
      !i.base
    ) {
      return false;
    }
    if (allowedTickers && allowedTickers.size > 0) {
      return allowedTickers.has(String(i.base).toUpperCase());
    }
    return true;
  });

  const tickers = await mapPool(instruments, GRVT_CONCURRENCY, (i) =>
    grvtPost<GrvtTickerPayload>(TICKER_API, { instrument: i.instrument }, 0),
  );

  const out = new Map<string, HedgeMarket>();

  instruments.forEach((inst, idx) => {
    const settled = tickers[idx];
    if (settled.status !== "fulfilled" || !settled.value?.result) return;
    const t = settled.value.result;

    const base = String(inst.base).toUpperCase();
    const intervalHours = inst.funding_interval_hours || 8;
    const rate = num(t.funding_rate);
    const longDailyPct = rate * (HOURS_PER_DAY / intervalHours);
    const markPrice = num(t.mark_price);

    out.set(base, {
      venue: "grvt",
      asset: base,
      market: String(inst.instrument),
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalHours * 3600,
      // Same convention as the other venues: an exact-zero rate is treated as
      // missing/closed rather than genuine free carry.
      stale: rate === 0,
      volume24hUsd: num(t.buy_volume_24h_q) + num(t.sell_volume_24h_q),
      openInterestUsd: num(t.open_interest) * markPrice,
    });
  });

  return out;
}
