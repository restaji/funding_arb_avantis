import { fetchJson } from "@/lib/net";
import { futuresRoot, parseVerantaSymbol } from "@/lib/symbols";
import type { VerantaMarket } from "@/lib/types";
import { fetchVerantaVolumes } from "@/lib/venues/verantaVolume";

const TRADING_API = "https://data.veranta.xyz/v2/trading";

interface VerantaPairInfo {
  index?: number;
  from?: string;
  to?: string;
  isPairListed?: boolean;
  pairOI?: number | string;
  pairMaxOI?: number | string;
  volume24hUsd?: number | string;
  openInterest?: { long?: number | string; short?: number | string };
  fundingRate?: { long?: number | string; short?: number | string };
  marginFee?: { long?: number | string; short?: number | string };
  feed?: {
    attributes?: {
      symbol?: string;
      isOpen?: boolean;
      is_open?: boolean;
    };
  };
}

interface VerantaTradingPayload {
  pairInfos?: Record<string, VerantaPairInfo>;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const isUpside = (info: VerantaPairInfo): boolean =>
  Boolean(info.from?.toUpperCase().includes("_UPSIDE"));

/**
 * Veranta rolls dated futures (WTI/CLL, BRENT) across multiple live contracts at
 * once, e.g. both WTIM6 (near-month, rolling off) and CLLZ6 (active) can be
 * listed simultaneously. Both parse to distinct bases and both hedge to the
 * same Variational ticker, so left alone they'd show up as duplicate rows —
 * one real, one dead. Keep only the contract that actually trades.
 */
function dropStaleFuturesRolls(markets: Map<string, VerantaMarket>): void {
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
 * Every Veranta pair, keyed by canonical base symbol.
 *
 * Mainnet pair book, funding, borrow fees, calendar and open interest (total
 * and long/short) all come from data.veranta.xyz/v2/trading. Veranta's net
 * holding rate per side is `fundingRate.{long,short} + marginFee.{long,short}`
 * (matching the Veranta trade UI's "Net Rate (L/S) = borrow fees + funding"):
 * `fundingRate` is trader-to-trader skew funding (can be negative, i.e. paid
 * to that side) and `marginFee` is the LP borrow fee (always >= 0).
 *
 * Both fields are percent per hour, positive = that side pays; daily is hourly x 24.
 *
 * 24h volume is not on that payload, so it is joined from the history
 * analytics endpoint on pair index — the same `/1/true` call the Veranta
 * trade UI uses. A pair missing from that feed traded nothing. Volume gates
 * the ranking, so a failure there has to surface as a venue error rather
 * than as a table of silent zeroes.
 */
export async function fetchVerantaMarkets(): Promise<Map<string, VerantaMarket>> {
  const [payload, volumes] = await Promise.all([
    fetchJson<VerantaTradingPayload>(TRADING_API),
    fetchVerantaVolumes().catch(() => new Map<number, number>()),
  ]);

  const pairInfos = Object.values(payload.pairInfos ?? {});
  const out = new Map<string, VerantaMarket>();

  for (const info of pairInfos) {
    // Zero-fee / profit-share wrapper pairs (e.g. ETH_UPSIDE/USD, BTC_UPSIDE/USD)
    // share their underlying asset's price feed (`Crypto.ETH/USD`, `Crypto.BTC/USD`).
    // They are a separate profit-sharing product and are excluded completely so
    // only the standard fixed-fee pair (index 0 ETH/USD, index 1 BTC/USD, etc.)
    // is used for funding, borrow, OI, and 24h volume.
    if (isUpside(info) || info.isPairListed === false) continue;

    const attrs = info.feed?.attributes;
    const parsed = parseVerantaSymbol(attrs?.symbol);
    // Retired slots carry an empty symbol and isPairListed=false.
    if (!parsed) continue;

    const pairIndex = Number(info.index);
    if (!Number.isInteger(pairIndex)) continue;

    const longOiUsd = num(info.openInterest?.long);
    const shortOiUsd = num(info.openInterest?.short);
    const longHourlyPct = num(info.fundingRate?.long) + num(info.marginFee?.long);
    const shortHourlyPct = num(info.fundingRate?.short) + num(info.marginFee?.short);

    out.set(parsed.base, {
      venue: "veranta",
      asset: parsed.base,
      market: attrs?.symbol ?? `${info.from}/${info.to}`,
      pairIndex,
      klass: parsed.klass,
      isOpen: attrs?.is_open ?? attrs?.isOpen ?? false,
      longDailyPct: longHourlyPct * 24,
      shortDailyPct: shortHourlyPct * 24,
      fundingIntervalS: 3600,
      // Net rate accrues continuously, so a zero here is a real zero.
      stale: false,
      openInterestUsd: num(info.pairOI) || longOiUsd + shortOiUsd,
      maxOpenInterestUsd: num(info.pairMaxOI),
      longOiUsd,
      shortOiUsd,
      // Prefer a per-pair print if Veranta starts publishing it here; otherwise
      // the history join. Missing from both means no flow.
      volume24hUsd: num(info.volume24hUsd) || volumes.get(pairIndex) || 0,
    });
  }

  dropStaleFuturesRolls(out);

  return out;
}
