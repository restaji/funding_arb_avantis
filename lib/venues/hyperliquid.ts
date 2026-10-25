import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const INFO_API = "https://api.hyperliquid.xyz/info";

interface HlUniverseItem {
  name?: string;
  isDelisted?: boolean;
}

interface HlAssetCtx {
  funding?: string | number;
  openInterest?: string | number;
  dayNtlVlm?: string | number;
  markPx?: string | number;
}

type HlMetaAndCtxs = [{ universe?: HlUniverseItem[] }, HlAssetCtx[]];

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

async function postMetaAndCtxs(dex?: string): Promise<HlMetaAndCtxs> {
  const body = dex
    ? { type: "metaAndAssetCtxs", dex }
    : { type: "metaAndAssetCtxs" };

  return fetchJson<HlMetaAndCtxs>(INFO_API, {
    method: "POST",
    body,
  });
}

/**
 * Every Hyperliquid perpetual across both the main L1 book (crypto) and the
 * `xyz` HIP-3 builder dex (equities, commodities, metals, FX).
 *
 * Funding settles hourly. `funding` on `assetCtxs` is the current-hour decimal
 * fraction (positive = longs pay shorts). Daily % is `funding * 24 * 100`.
 * `openInterest` is in base units, so USD OI is `openInterest * markPx`;
 * `dayNtlVlm` is already USD notional.
 *
 * Main-book tickers are keyed bare (e.g. `BTC`, `kBONK`); `xyz` tickers retain
 * their `xyz:` prefix in the map (e.g. `XYZ:NVDA`, `XYZ:GOLD`) so equity/RWA
 * symbols never collide with main-book crypto tokens (`STX`, `DASH`, etc.).
 */
export async function fetchHyperliquidMarkets(): Promise<Map<string, HedgeMarket>> {
  const [mainData, xyzData] = await Promise.all([
    postMetaAndCtxs(),
    postMetaAndCtxs("xyz"),
  ]);

  const out = new Map<string, HedgeMarket>();

  const ingest = (payload: HlMetaAndCtxs, isXyz: boolean) => {
    const universe = payload?.[0]?.universe ?? [];
    const ctxs = payload?.[1] ?? [];

    universe.forEach((u, i) => {
      const rawName = u?.name;
      const ctx = ctxs[i];
      if (!rawName || !ctx || u.isDelisted) return;

      const stripped = rawName.replace(/^xyz:/i, "");
      const key = isXyz ? `XYZ:${stripped.toUpperCase()}` : stripped.toUpperCase();
      const market = isXyz ? `xyz:${stripped}` : stripped;

      const hourlyFrac = num(ctx.funding);
      const longDailyPct = hourlyFrac * HOURS_PER_DAY * 100;
      const markPx = num(ctx.markPx);
      const openInterestUsd = num(ctx.openInterest) * markPx;
      const volume24hUsd = num(ctx.dayNtlVlm);

      out.set(key, {
        venue: "hyperliquid",
        asset: stripped.toUpperCase(),
        market,
        name: stripped,
        longDailyPct,
        shortDailyPct: -longDailyPct,
        fundingIntervalS: 3600,
        // Closed RWA/FX feeds on xyz report 0.0 funding.
        stale: hourlyFrac === 0,
        volume24hUsd,
        openInterestUsd,
      });
    });
  };

  ingest(mainData, false);
  ingest(xyzData, true);

  return out;
}
