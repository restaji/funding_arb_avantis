import { parseAvantisSymbol } from "@/lib/symbols";
import type { AvantisMarket } from "@/lib/types";
import { fetchAvantisVolumes } from "@/lib/venues/avantisVolume";

const PAIRS_API = "https://tx-builder-testnet.avantisfi.com/v2/pairs?raw=true";
const SOCKET_API =
  "https://socket-api-pub.avantisfi.com/socket-api/v1/data?override=true";

interface AvantisPairInfo {
  index: number;
  symbol?: string;
  feed?: {
    attributes?: {
      symbol?: string;
      asset_type?: string;
      is_open?: boolean;
      isOpen?: boolean;
    };
  };
  raw?: {
    fundingRate?: { long?: number | string; short?: number | string };
  };
}

interface AvantisPayload {
  ok?: boolean;
  data?: AvantisPairInfo[];
}

interface AvantisOiInfo {
  pairOI?: number | string;
  pairMaxOI?: number | string;
}

interface AvantisOiPayload {
  data?: { pairInfos?: Record<string, AvantisOiInfo> };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Standard futures month codes: F,G,H,J,K,M,N,Q,U,V,X,Z (Jan..Dec).
const FUTURES_EXPIRY = /^([A-Z]+)[FGHJKMNQUVXZ]\d$/;

/**
 * Root commodity for a dated-futures base, e.g. "WTIU6" / "WTIM6" -> "WTI".
 * Returns null for bases that aren't a dated-futures contract.
 */
function futuresRoot(base: string): string | null {
  const m = FUTURES_EXPIRY.exec(base);
  return m ? m[1] : null;
}

/**
 * Avantis rolls dated futures (WTI, BRENT) across multiple live contracts at
 * once, e.g. both WTIM6 (near-month, rolling off) and WTIU6 (active) can be
 * listed simultaneously. Both parse to distinct bases and both hedge to the
 * same Variational ticker, so left alone they'd show up as duplicate rows —
 * one real, one dead. Keep only the contract that actually trades.
 */
function dropStaleFuturesRolls(markets: Map<string, AvantisMarket>): void {
  const groups = new Map<string, string[]>();
  for (const base of markets.keys()) {
    const root = futuresRoot(base);
    if (!root) continue;
    const bucket = groups.get(root) ?? [];
    bucket.push(base);
    groups.set(root, bucket);
  }

  for (const bases of groups.values()) {
    if (bases.length < 2) continue;
    const ranked = bases
      .map((base) => markets.get(base)!)
      .sort(
        (a, b) =>
          b.volume24hUsd - a.volume24hUsd || b.openInterestUsd - a.openInterestUsd,
      );
    // The one with a real number wins; the rest (0 volume, 0 OI) are dropped.
    for (const stale of ranked.slice(1)) {
      markets.delete(stale.asset);
    }
  }
}

/**
 * Every Avantis pair, keyed by canonical base symbol.
 *
 * Avantis's new funding-rate model has longs and shorts on opposite sides of
 * one skew-driven rate, so fundingRate.long and fundingRate.short can be
 * negative (that side is paid) — unlike the old flat, always-positive
 * marginFee borrow rate this replaces.
 *
 * fundingRate is percent per hour; daily is hourly x 24.
 *
 * The tx-builder pairs list is testnet, so its pairOI/pairMaxOI aren't real —
 * open interest is joined in from the mainnet socket-api instead, keyed by
 * pair index (stable across both feeds). 24h volume comes from a third
 * Avantis endpoint, also joined on pair index. Neither is optional: both gate
 * the ranking, so a failure there has to surface as a venue error rather than
 * as a table of silent zeroes.
 */
export async function fetchAvantisMarkets(): Promise<Map<string, AvantisMarket>> {
  const [res, oiRes, volumes] = await Promise.all([
    fetch(PAIRS_API, {
      next: { revalidate: 120, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    }),
    fetch(SOCKET_API, {
      next: { revalidate: 120, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    }),
    fetchAvantisVolumes(),
  ]);
  if (!res.ok) throw new Error(`Avantis tx-builder pairs ${res.status}`);
  if (!oiRes.ok) throw new Error(`Avantis socket-api ${oiRes.status}`);

  const [payload, oiPayload] = await Promise.all([
    res.json() as Promise<AvantisPayload>,
    oiRes.json() as Promise<AvantisOiPayload>,
  ]);
  const pairInfos = payload.data ?? [];
  const oiByIndex = new Map<number, AvantisOiInfo>();
  for (const [idx, info] of Object.entries(oiPayload.data?.pairInfos ?? {})) {
    oiByIndex.set(Number(idx), info);
  }
  const out = new Map<string, AvantisMarket>();

  for (const info of pairInfos) {
    // Leveraged wrapper pairs (e.g. BTC_UPSIDE/USD) share their underlying
    // asset's price feed, so they'd parse to the same base symbol as the
    // real pair and silently clobber it in the map below. They're a
    // different product, not the same tradable asset — skip them.
    if (info.symbol?.includes("_UPSIDE")) continue;

    const attrs = info.feed?.attributes;
    const parsed = parseAvantisSymbol(attrs?.symbol);
    // Retired slots carry an empty symbol.
    if (!parsed) continue;

    const pairIndex = info.index;
    const fundingRate = info.raw?.fundingRate;
    const oi = oiByIndex.get(pairIndex);

    out.set(parsed.base, {
      venue: "avantis",
      asset: parsed.base,
      market: attrs?.symbol ?? `pair ${pairIndex}`,
      pairIndex,
      klass: parsed.klass,
      isOpen: attrs?.is_open ?? attrs?.isOpen ?? false,
      longDailyPct: num(fundingRate?.long) * 24,
      shortDailyPct: num(fundingRate?.short) * 24,
      fundingIntervalS: 3600,
      // The funding rate accrues continuously, so a zero here is a real zero.
      stale: false,
      openInterestUsd: num(oi?.pairOI),
      maxOpenInterestUsd: num(oi?.pairMaxOI),
      volume24hUsd: volumes.get(pairIndex) ?? 0,
    });
  }

  dropStaleFuturesRolls(out);

  return out;
}
