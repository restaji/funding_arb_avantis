import type { VariationalMarket } from "@/lib/types";

const STATS_API =
  "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats";

interface VariationalListing {
  ticker?: string;
  name?: string;
  funding_rate?: string | number;
  funding_interval_s?: string | number;
  volume_24h?: string | number;
  open_interest?: {
    long_open_interest?: string | number;
    short_open_interest?: string | number;
  };
}

interface VariationalPayload {
  listings?: VariationalListing[];
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const DAYS_PER_YEAR = 365;

/**
 * Every Variational listing, keyed by ticker.
 *
 * Classic perp funding: longs pay when the rate is positive and the two sides
 * are exact mirrors.
 *
 * funding_rate is an ANNUALIZED FRACTION, not a per-interval percent. The
 * giveaway is the baseline: ~300 listings sit at exactly 0.1095, which is
 * 10.95% a year, i.e. the standard 0.01% per 8h — and they sit there on both
 * the 4h and the 8h schedule, which only makes sense if the number is already
 * annualized. It matches the app UI too: BTC at 0.04988 shows as 0.0045% per
 * 8h, and 0.04988 x 28800 / 31_536_000 = 0.004555%.
 *
 * So funding_interval_s is the settlement cadence only. It must not be used to
 * scale the rate, or 4h markets come out at twice the size of 8h ones.
 *
 * This host is not the Cloudflare-gated one — omni.variational.io needs TLS
 * impersonation, omni-client-api.prod does not.
 */
export async function fetchVariationalMarkets(): Promise<Map<string, VariationalMarket>> {
  const res = await fetch(STATS_API, {
    next: { revalidate: 120, tags: ["funding"] },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Variational /metadata/stats ${res.status}`);

  const payload = (await res.json()) as VariationalPayload;
  const out = new Map<string, VariationalMarket>();

  for (const l of payload.listings ?? []) {
    if (!l?.ticker) continue;
    const ticker = String(l.ticker).toUpperCase();

    const annualRate = num(l.funding_rate);
    const intervalS = Math.max(1, Math.trunc(num(l.funding_interval_s) || 3600));
    const longDailyPct = (annualRate * 100) / DAYS_PER_YEAR;

    const oi = l.open_interest;
    const openInterestUsd =
      num(oi?.long_open_interest) + num(oi?.short_open_interest);

    out.set(ticker, {
      venue: "variational",
      asset: ticker,
      market: ticker,
      name: l.name ? String(l.name) : ticker,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalS,
      // Scheduled markets report exactly zero when shut, which is missing
      // data rather than free carry.
      stale: annualRate === 0,
      volume24hUsd: num(l.volume_24h),
      openInterestUsd,
    });
  }

  return out;
}
