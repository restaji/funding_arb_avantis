import type { OndoMarket } from "@/lib/types";

const CONTRACTS_API = "https://api.ondoperps.xyz/v1/perps/contracts";
const MARKETS_API = "https://api.ondoperps.xyz/v1/markets";

interface OndoContract {
  market?: string;
  displayName?: string;
  disabled?: boolean;
  isClosed?: boolean;
  fundingRate?: string | number;
  nextFundingRate?: string | number;
  openInterestUsd?: string | number;
  usdVolume?: string | number;
}

interface OndoContractsPayload {
  success?: boolean;
  result?: OndoContract[];
}

interface OndoTradingPair {
  market?: string;
  longName?: string;
}

interface OndoMarketsPayload {
  result?: { perps?: { tradingPairs?: OndoTradingPair[] | null } };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

/** "XAU-USD.P" -> "XAU". Every perp is quoted in USD and suffixed .P. */
function baseOf(market: string): string | null {
  const m = /^([A-Z0-9]+)-USD\.P$/.exec(market.toUpperCase());
  return m ? m[1] : null;
}

/**
 * Market -> long name, e.g. "XAU-USD.P" -> "Gold".
 *
 * Purely cosmetic: it supplies the row label. /v1/perps/contracts only carries
 * the squashed "XAUUSD" display name, so this is a second call — but a failure
 * here must not take the venue down with it, hence the swallow.
 */
async function fetchOndoNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const res = await fetch(MARKETS_API, {
      next: { revalidate: 3600, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return out;

    const payload = (await res.json()) as OndoMarketsPayload;
    for (const p of payload.result?.perps?.tradingPairs ?? []) {
      if (p?.market && p.longName) out.set(p.market.toUpperCase(), p.longName);
    }
  } catch {
    // Names are decoration; rates are the product.
  }
  return out;
}

/**
 * Every Ondo Perps market, keyed by base symbol.
 *
 * Ondo is a classic peer-to-peer perp: one rate, longs pay shorts when it is
 * positive, and the protocol takes no cut — so the two sides are exact
 * mirrors, same as Variational.
 *
 * fundingRate is a PER-HOUR FRACTION and settles hourly on UTC hour
 * boundaries, so daily is hourly x 24. The published rate already has the
 * venue's /8 premium smoothing baked in; do not divide again. Sanity check:
 * a market sitting on its oracle pays the 0.03%/day interest baseline, which
 * shows up here as exactly 0.0000125.
 *
 * `nextFundingRate` is the estimate for the interval now running and is what
 * the Ondo UI displays, so it is the forward-looking number a carry decision
 * actually needs. `fundingRate` is the interval that already settled and is
 * only a fallback.
 */
export async function fetchOndoMarkets(): Promise<Map<string, OndoMarket>> {
  const [res, names] = await Promise.all([
    fetch(CONTRACTS_API, {
      next: { revalidate: 120, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    }),
    fetchOndoNames(),
  ]);
  if (!res.ok) throw new Error(`Ondo /v1/perps/contracts ${res.status}`);

  const payload = (await res.json()) as OndoContractsPayload;
  const out = new Map<string, OndoMarket>();

  for (const c of payload.result ?? []) {
    if (!c?.market) continue;
    const market = String(c.market).toUpperCase();
    const base = baseOf(market);
    if (!base) continue;

    const hourly =
      c.nextFundingRate !== undefined && c.nextFundingRate !== null
        ? num(c.nextFundingRate)
        : num(c.fundingRate);
    const longDailyPct = hourly * HOURS_PER_DAY * 100;

    out.set(base, {
      venue: "ondo",
      asset: base,
      market,
      name: names.get(market) ?? c.displayName ?? base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: 3600,
      // Ondo voids funding for an hour whenever the premium sampler drops more
      // than 6 minutes of data, so an exact zero is missing data, not free
      // carry. A disabled market cannot be traded at all.
      stale: Boolean(c.disabled) || hourly === 0,
      underlyingClosed: Boolean(c.isClosed),
      volume24hUsd: num(c.usdVolume),
      openInterestUsd: num(c.openInterestUsd),
    });
  }

  return out;
}
