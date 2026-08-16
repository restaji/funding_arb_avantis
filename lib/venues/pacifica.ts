import type { HedgeMarket } from "@/lib/types";

const PRICES_API = "https://api.pacifica.fi/api/v1/info/prices";

interface PacificaPrice {
  symbol?: string;
  funding?: string | number;
  next_funding?: string | number;
  mark?: string | number;
  open_interest?: string | number;
  volume_24h?: string | number;
}

interface PacificaPricesPayload {
  success?: boolean;
  data?: PacificaPrice[];
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

/**
 * Every Pacifica perpetual, keyed by symbol.
 *
 * Classic perp: one rate, longs pay shorts when it is positive, sides are
 * exact mirrors. Funding settles hourly. `next_funding` is the TWAP the
 * Pacifica UI shows for the hour now running, so that is the forward-looking
 * number a carry decision needs. `funding` is the hour that already settled
 * and is only a fallback.
 *
 * Both fields are a PER-HOUR FRACTION. Daily is hourly x 24 x 100. A market
 * sitting on its oracle prints exactly 0.0000125, which is the same 0.03%/day
 * interest baseline Ondo publishes as an hourly fraction — Pacifica's formula
 * is (premium + clamp(0.01% − premium, ±0.05%)) / 8.
 *
 * SOL-USDC is a spot market (hyphenated, no funding) and is skipped. The
 * docs claim open_interest is USD; live prints are in base units (BTC OI of
 * ~680 at a ~$63k mark is ~$43M, not $680), so OI is mark-multiplied.
 */
export async function fetchPacificaMarkets(): Promise<Map<string, HedgeMarket>> {
  const res = await fetch(PRICES_API, {
    next: { revalidate: 120, tags: ["funding"] },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Pacifica /api/v1/info/prices ${res.status}`);

  const payload = (await res.json()) as PacificaPricesPayload;
  const out = new Map<string, HedgeMarket>();

  for (const p of payload.data ?? []) {
    if (!p?.symbol) continue;
    const raw = String(p.symbol);
    const symbol = raw.toUpperCase();
    // Spot pairs are hyphenated (SOL-USDC) and carry no funding.
    if (symbol.includes("-")) continue;

    const hourly =
      p.next_funding !== undefined && p.next_funding !== null
        ? num(p.next_funding)
        : num(p.funding);
    const longDailyPct = hourly * HOURS_PER_DAY * 100;
    const mark = num(p.mark);

    out.set(symbol, {
      venue: "pacifica",
      asset: symbol,
      market: raw,
      name: raw,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: 3600,
      // Exact zero is missing data — the resting oracle print is 0.0000125,
      // never 0. Spot already dropped above.
      stale: hourly === 0,
      volume24hUsd: num(p.volume_24h),
      openInterestUsd: num(p.open_interest) * mark,
    });
  }

  return out;
}
