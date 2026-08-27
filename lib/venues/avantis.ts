import { futuresRoot, parseAvantisSymbol } from "@/lib/symbols";
import type { AvantisMarket } from "@/lib/types";
import { fetchAvantisVolumes } from "@/lib/venues/avantisVolume";

const TRADING_API = "https://data.avantisfi.com/v2/trading";

interface AvantisPairInfo {
  index?: number;
  from?: string;
  to?: string;
  isPairListed?: boolean;
  pairOI?: number | string;
  pairMaxOI?: number | string;
  volume24hUsd?: number | string;
  openInterest?: { long?: number | string; short?: number | string };
  fundingRate?: { long?: number | string; short?: number | string };
  feed?: {
    attributes?: {
      symbol?: string;
      isOpen?: boolean;
      is_open?: boolean;
    };
  };
}

interface AvantisTradingPayload {
  pairInfos?: Record<string, AvantisPairInfo>;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const isUpside = (info: AvantisPairInfo): boolean =>
  Boolean(info.from?.includes("_UPSIDE"));

/**
 * The Avantis trade UI's 24h Volume is the listed pair plus its `_UPSIDE`
 * sibling (same Pyth symbol, different product). Fold that sibling into the
 * base index so the board matches what the UI prints.
 */
function foldUpsideVolume(
  pairs: AvantisPairInfo[],
  volumes: Map<number, number>,
): void {
  const baseIndexBySymbol = new Map<string, number>();
  for (const info of pairs) {
    if (isUpside(info)) continue;
    const symbol = info.feed?.attributes?.symbol;
    const idx = Number(info.index);
    if (symbol && Number.isInteger(idx)) baseIndexBySymbol.set(symbol, idx);
  }

  for (const info of pairs) {
    if (!isUpside(info)) continue;
    const symbol = info.feed?.attributes?.symbol;
    const idx = Number(info.index);
    const baseIdx = symbol ? baseIndexBySymbol.get(symbol) : undefined;
    if (baseIdx === undefined || !Number.isInteger(idx)) continue;
    const extra = volumes.get(idx) ?? 0;
    if (extra <= 0) continue;
    volumes.set(baseIdx, (volumes.get(baseIdx) ?? 0) + extra);
  }
}

/**
 * Avantis rolls dated futures (WTI, BRENT) across multiple live contracts at
 * once, e.g. both WTIM6 (near-month, rolling off) and WTIV6 (active) can be
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
 * Mainnet pair book, funding, calendar and open interest (total and long/short)
 * all come from data.avantisfi.com/v2/trading. Avantis's funding-rate model has
 * longs and shorts on opposite sides of one skew-driven rate, so
 * fundingRate.long and fundingRate.short can be negative (that side is paid).
 *
 * fundingRate is percent per hour; daily is hourly x 24.
 *
 * 24h volume is not on that payload, so it is joined from the history
 * analytics endpoint on pair index — the same `/1/true` call the Avantis
 * trade UI uses. A pair missing from that feed traded nothing. Volume gates
 * the ranking, so a failure there has to surface as a venue error rather
 * than as a table of silent zeroes.
 */
export async function fetchAvantisMarkets(): Promise<Map<string, AvantisMarket>> {
  const [res, volumes] = await Promise.all([
    fetch(TRADING_API, {
      next: { revalidate: 120, tags: ["funding"] },
      signal: AbortSignal.timeout(15000),
    }),
    fetchAvantisVolumes(),
  ]);
  if (!res.ok) throw new Error(`Avantis trading ${res.status}`);

  const payload = (await res.json()) as AvantisTradingPayload;
  const pairInfos = Object.values(payload.pairInfos ?? {});
  foldUpsideVolume(pairInfos, volumes);
  const out = new Map<string, AvantisMarket>();

  for (const info of pairInfos) {
    // Leveraged wrapper pairs (e.g. BTC_UPSIDE/USD) share their underlying
    // asset's price feed, so they'd parse to the same base symbol as the
    // real pair and silently clobber it in the map below. They're a
    // different product — skip the row, but their volume is already folded
    // into the underlying pair above, matching the Avantis UI.
    if (isUpside(info)) continue;

    const attrs = info.feed?.attributes;
    const parsed = parseAvantisSymbol(attrs?.symbol);
    // Retired slots carry an empty symbol and isPairListed=false.
    if (!parsed) continue;

    const pairIndex = Number(info.index);
    if (!Number.isInteger(pairIndex)) continue;

    const longOiUsd = num(info.openInterest?.long);
    const shortOiUsd = num(info.openInterest?.short);

    out.set(parsed.base, {
      venue: "avantis",
      asset: parsed.base,
      market: attrs?.symbol ?? `${info.from}/${info.to}`,
      pairIndex,
      klass: parsed.klass,
      isOpen: attrs?.is_open ?? attrs?.isOpen ?? false,
      longDailyPct: num(info.fundingRate?.long) * 24,
      shortDailyPct: num(info.fundingRate?.short) * 24,
      fundingIntervalS: 3600,
      // The funding rate accrues continuously, so a zero here is a real zero.
      stale: false,
      openInterestUsd: num(info.pairOI) || longOiUsd + shortOiUsd,
      maxOpenInterestUsd: num(info.pairMaxOI),
      longOiUsd,
      shortOiUsd,
      // Prefer a per-pair print if Avantis starts publishing it here; otherwise
      // the history join. Missing from both means no flow.
      volume24hUsd: num(info.volume24hUsd) || volumes.get(pairIndex) || 0,
    });
  }

  dropStaleFuturesRolls(out);

  return out;
}
