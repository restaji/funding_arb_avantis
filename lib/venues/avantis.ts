import { parseAvantisSymbol } from "@/lib/symbols";
import type { AvantisMarket } from "@/lib/types";
import { fetchAvantisVolumes } from "@/lib/venues/avantisVolume";

const SOCKET_API =
  "https://socket-api-pub.avantisfi.com/socket-api/v1/data?override=true";

interface AvantisPairInfo {
  feed?: {
    attributes?: {
      symbol?: string;
      asset_type?: string;
      is_open?: boolean;
      isOpen?: boolean;
    };
  };
  marginFee?: { long?: number | string; short?: number | string };
  pairOI?: number | string;
  pairMaxOI?: number | string;
}

interface AvantisPayload {
  data?: { pairInfos?: Record<string, AvantisPairInfo> };
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
 * Avantis charges a borrow fee to the LPs and both sides pay their own rate —
 * a short does not receive the long fee. So marginFee.long and marginFee.short
 * are independent and both non-negative.
 *
 * marginFee is percent per hour; daily is hourly x 24.
 *
 * 24h volume comes from a second Avantis endpoint and is joined on pair index.
 * It is not optional: it gates the whole ranking, so a failure there has to
 * surface as a venue error rather than as a table of silent zeroes.
 */
export async function fetchAvantisMarkets(): Promise<Map<string, AvantisMarket>> {
  const [res, volumes] = await Promise.all([
    fetch(SOCKET_API, {
      next: { revalidate: 120, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    }),
    fetchAvantisVolumes(),
  ]);
  if (!res.ok) throw new Error(`Avantis socket-api ${res.status}`);

  const payload = (await res.json()) as AvantisPayload;
  const pairInfos = payload.data?.pairInfos ?? {};
  const out = new Map<string, AvantisMarket>();

  for (const [idx, info] of Object.entries(pairInfos)) {
    const attrs = info?.feed?.attributes;
    const parsed = parseAvantisSymbol(attrs?.symbol);
    // Retired slots carry an empty symbol.
    if (!parsed) continue;

    const maxOi = num(info.pairMaxOI);
    const pairIndex = Number(idx);

    out.set(parsed.base, {
      venue: "avantis",
      asset: parsed.base,
      market: attrs?.symbol ?? `pair ${idx}`,
      pairIndex,
      klass: parsed.klass,
      isOpen: attrs?.is_open ?? attrs?.isOpen ?? false,
      longDailyPct: num(info.marginFee?.long) * 24,
      shortDailyPct: num(info.marginFee?.short) * 24,
      fundingIntervalS: 3600,
      // The borrow fee accrues continuously, so a zero here is a real zero.
      stale: false,
      openInterestUsd: num(info.pairOI),
      maxOpenInterestUsd: maxOi,
      volume24hUsd: volumes.get(pairIndex) ?? 0,
    });
  }

  dropStaleFuturesRolls(out);

  return out;
}
