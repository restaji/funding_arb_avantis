import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const BASE = "https://perps-api.jup.ag/v1";
const POOL_INFO_API = `${BASE}/pool-info`;
const MARKET_STATS_API = `${BASE}/market-stats`;
const JLP_INFO_API = `${BASE}/jlp-info`;

interface JupiterMarketMeta {
  asset: string;
  market: string;
  name: string;
  custodySymbol: string;
  mint: string;
}

const JUPITER_MARKETS: JupiterMarketMeta[] = [
  {
    asset: "SOL",
    market: "SOL-PERP",
    name: "Solana",
    custodySymbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
  },
  {
    asset: "ETH",
    market: "ETH-PERP",
    name: "Ethereum",
    custodySymbol: "ETH",
    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  },
  {
    asset: "BTC",
    market: "WBTC-PERP",
    name: "Bitcoin",
    custodySymbol: "WBTC",
    mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  },
];

interface JupiterPoolInfo {
  longBorrowRatePercent?: string | number;
  shortBorrowRatePercent?: string | number;
  longUtilizationPercent?: string | number;
}

interface JupiterMarketStats {
  volume?: string | number;
}

interface JupiterJlpInfo {
  custodies?: Array<{
    symbol?: string;
    aumUsd?: string | number;
    utilizationPct?: string | number;
  }>;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;
const USD_DECIMALS = 1e6;

/**
 * Every Jupiter Perpetuals market (`SOL`, `ETH`, `BTC`), keyed by canonical base symbol.
 *
 * Jupiter Perps has no two-sided peer-to-peer funding rate. Instead, every open
 * position pays a continuous **borrow fee** to the JLP pool on both sides:
 * - Longs borrow the underlying custody asset (`longBorrowRatePercent`, %/hour).
 * - Shorts borrow USDC (`shortBorrowRatePercent`, %/hour).
 *
 * Both fields on `/v1/pool-info` are already in **percent per hour** (e.g.
 * `0.0014` = `0.0014%/hr`), and because both sides pay the pool, `longDailyPct`
 * and `shortDailyPct` are both positive (`ratePctPerHour * 24`).
 */
export async function fetchJupiterMarkets(): Promise<Map<string, HedgeMarket>> {
  const [jlpInfo, perMarket] = await Promise.all([
    fetchJson<JupiterJlpInfo>(JLP_INFO_API).catch(() => null),
    Promise.all(
      JUPITER_MARKETS.map(async (m) => {
        const [pool, stats] = await Promise.all([
          fetchJson<JupiterPoolInfo>(`${POOL_INFO_API}?mint=${m.mint}`),
          fetchJson<JupiterMarketStats>(`${MARKET_STATS_API}?mint=${m.mint}`).catch(
            () => null,
          ),
        ]);
        return { m, pool, stats };
      }),
    ),
  ]);

  const custodyAumUsd = new Map<string, number>();
  for (const c of jlpInfo?.custodies ?? []) {
    if (c?.symbol) {
      custodyAumUsd.set(c.symbol.toUpperCase(), num(c.aumUsd) / USD_DECIMALS);
    }
  }

  const out = new Map<string, HedgeMarket>();

  for (const { m, pool, stats } of perMarket) {
    const longHourlyPct = num(pool.longBorrowRatePercent);
    const shortHourlyPct = num(pool.shortBorrowRatePercent);
    const longDailyPct = longHourlyPct * HOURS_PER_DAY;
    const shortDailyPct = shortHourlyPct * HOURS_PER_DAY;

    const aum = custodyAumUsd.get(m.custodySymbol) ?? 0;
    const utilPct = num(pool.longUtilizationPercent);
    const openInterestUsd = aum > 0 && utilPct > 0 ? aum * (utilPct / 100) : 0;

    out.set(m.asset, {
      venue: "jupiter",
      asset: m.asset,
      market: m.market,
      name: m.name,
      longDailyPct,
      shortDailyPct,
      fundingIntervalS: 3600,
      stale: longHourlyPct === 0 && shortHourlyPct === 0,
      volume24hUsd: num(stats?.volume),
      openInterestUsd,
    });
  }

  return out;
}
