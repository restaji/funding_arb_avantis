import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const PAIRS_API = "https://app.ostium.com/api/pairs";

interface OstiumPair {
  from?: string;
  to?: string;
  maxOI?: string | number;
  isNegativeRolloverAllowed?: boolean;
  rolloverFeePerBlock?: string | number;
  lastRolloverLongPure?: string | number;
  brokerPremium?: string | number;
  curFundingLong?: string | number;
  curFundingShort?: string | number;
  longOI?: string | number;
  shortOI?: string | number;
  lastTradePrice?: string | number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Arbitrum target block rate assumed by Ostium's on-chain rollover math
// (4 blocks/s * 86,400 s/day = 345,600 blocks/day), and 1e18 fixed-point scale.
const BLOCKS_PER_DAY = 345_600;
const PRECISION_18 = 1e18;

/**
 * Every Ostium pair, keyed by `${from}${to}` (e.g. `XAUUSD`, `NVDAUSD`, `EURUSD`).
 *
 * Ostium accrues per-block rollover plus skew funding on Arbitrum:
 *   mid                   = lastRolloverLongPure || rolloverFeePerBlock
 *   longRolloverPerBlock  =  mid + brokerPremium
 *   shortRolloverPerBlock = -mid + brokerPremium
 *   longRatePerBlock      = longRolloverPerBlock  + curFundingLong
 *   shortRatePerBlock     = shortRolloverPerBlock + curFundingShort
 *
 * All per-block fields are 1e18-scaled fractions where positive = that side pays.
 * `brokerPremium` is added to both sides (a fee floor), so the two sides are not
 * exact negations of each other, but whenever `|mid| > brokerPremium` one side
 * goes negative and pays the holder.
 *
 * Ostium's `/api/pairs` does not publish 24h traded volume (`volume` is lifetime
 * cumulative), so `volume24hUsd` is reported as 0 (rendered as `—` in the UI).
 */
export async function fetchOstiumMarkets(): Promise<Map<string, HedgeMarket>> {
  const pairs = await fetchJson<OstiumPair[]>(PAIRS_API);
  const out = new Map<string, HedgeMarket>();

  for (const p of pairs ?? []) {
    if (!p?.from || !p?.to) continue;
    // Skip zero-cap pairs (e.g. USD/KRW with maxOI = 0) that cannot accept positions.
    if (p.maxOI !== undefined && num(p.maxOI) <= 0) continue;
    const from = String(p.from).toUpperCase();
    const to = String(p.to).toUpperCase();
    const key = `${from}${to}`;
    const market = `${from}/${to}`;

    const lastPure = num(p.lastRolloverLongPure);
    const fallbackRollover = num(p.rolloverFeePerBlock);
    const mid = lastPure !== 0 ? lastPure : fallbackRollover;
    const brokerPremium = num(p.brokerPremium);
    const curFundingLong = num(p.curFundingLong);
    const curFundingShort = num(p.curFundingShort);

    const clampRollover = (r: number): number =>
      p.isNegativeRolloverAllowed === false ? Math.max(0, r) : r;

    const longPerBlock = clampRollover(mid + brokerPremium) + curFundingLong;
    const shortPerBlock = clampRollover(-mid + brokerPremium) + curFundingShort;

    const toDailyPct = (perBlock: number): number =>
      ((perBlock * BLOCKS_PER_DAY) / PRECISION_18) * 100;

    const longDailyPct = toDailyPct(longPerBlock);
    const shortDailyPct = toDailyPct(shortPerBlock);

    const price = num(p.lastTradePrice) / PRECISION_18;
    const longOiBase = num(p.longOI) / PRECISION_18;
    const shortOiBase = num(p.shortOI) / PRECISION_18;
    const openInterestUsd = (longOiBase + shortOiBase) * price;

    out.set(key, {
      venue: "ostium",
      asset: from,
      market,
      name: market,
      longDailyPct,
      shortDailyPct,
      fundingIntervalS: 3600,
      stale: longPerBlock === 0 && shortPerBlock === 0,
      volume24hUsd: 0,
      openInterestUsd,
    });
  }

  return out;
}
