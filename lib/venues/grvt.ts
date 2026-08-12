import type { HedgeMarket } from "@/lib/types";

const BASE = "https://market-data.grvt.io/full/v1";
const INSTRUMENTS_API = `${BASE}/all_instruments`;
const TICKER_API = `${BASE}/ticker`;

/**
 * GRVT's whole Market Data API is POST-only, including reads — GET on any
 * endpoint here returns 405. Requests carry params as a JSON body, not a
 * query string.
 */
async function grvtPost<T>(url: string, body: unknown): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    next: { revalidate: 120, tags: ["funding"] },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

interface GrvtInstrument {
  instrument?: string;
  base?: string;
  quote?: string;
  kind?: string;
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

/**
 * Every GRVT perpetual, keyed by base symbol.
 *
 * There is no bulk ticker/funding endpoint — /full/v1/ticker only accepts one
 * `instrument` per call, so this fans out to one request per listing
 * (currently ~170, all USDT-quoted PERPETUAL). A per-instrument failure is
 * dropped rather than failing the venue.
 *
 * funding_rate is a percent already (not a fraction) settling every
 * funding_interval_hours, e.g. BTC sits at "0.01" (0.01%/8h), the standard
 * perp baseline. Daily is that scaled by 24/interval.
 */
export async function fetchGrvtMarkets(): Promise<Map<string, HedgeMarket>> {
  const instrumentsPayload = await grvtPost<GrvtInstrumentsPayload>(INSTRUMENTS_API, {});
  const instruments = (instrumentsPayload?.result ?? []).filter(
    (i) => i.kind === "PERPETUAL" && i.instrument && i.base,
  );

  const tickers = await Promise.allSettled(
    instruments.map((i) => grvtPost<GrvtTickerPayload>(TICKER_API, { instrument: i.instrument })),
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
