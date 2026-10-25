import { rankAssets } from "@/lib/rank";
import { hedgeTickerFor } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  type HedgeMarket,
  type HedgeVenueId,
  type ScanAsset,
  type ScanHedge,
  type ScanResult,
  type VenueId,
  type VerantaMarket,
} from "@/lib/types";
import { fetchAntarcticMarkets } from "@/lib/venues/antarctic";
import { fetchBinanceMarkets } from "@/lib/venues/binance";
import { fetchBybitMarkets } from "@/lib/venues/bybit";
import { fetchGateMarkets } from "@/lib/venues/gate";
import { fetchGrvtMarkets } from "@/lib/venues/grvt";
import { fetchHyperliquidMarkets } from "@/lib/venues/hyperliquid";
import { fetchJupiterMarkets } from "@/lib/venues/jupiter";
import { fetchLighterMarkets } from "@/lib/venues/lighter";
import { fetchOkxMarkets } from "@/lib/venues/okx";
import { fetchOndoMarkets } from "@/lib/venues/ondo";
import { fetchOstiumMarkets } from "@/lib/venues/ostium";
import { fetchPacificaMarkets } from "@/lib/venues/pacifica";
import { fetchVariationalMarkets } from "@/lib/venues/variational";
import { fetchVerantaMarkets } from "@/lib/venues/veranta";

/** How to load each hedge venue. Order here is the order shown in the UI. */
const HEDGE_FETCHERS: Record<HedgeVenueId, () => Promise<Map<string, HedgeMarket>>> = {
  hyperliquid: fetchHyperliquidMarkets,
  lighter: fetchLighterMarkets,
  ostium: fetchOstiumMarkets,
  variational: fetchVariationalMarkets,
  ondo: fetchOndoMarkets,
  grvt: fetchGrvtMarkets,
  pacifica: fetchPacificaMarkets,
  jupiter: fetchJupiterMarkets,
  antarctic: fetchAntarcticMarkets,
  binance: fetchBinanceMarkets,
  bybit: fetchBybitMarkets,
  okx: fetchOkxMarkets,
  gate: fetchGateMarkets,
};

export { aprFromBps, bestAcrossHedges, bestPair, netCarryBps, rankAssets } from "@/lib/rank";

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

let scanCache: { result: ScanResult; ts: number } | null = null;
let scanInFlight: Promise<ScanResult> | null = null;
const SCAN_CACHE_TTL_MS = 60 * 1000;

export function invalidateScanCache(): void {
  scanCache = null;
}

export async function scan(): Promise<ScanResult> {
  if (scanCache && Date.now() - scanCache.ts < SCAN_CACHE_TTL_MS) {
    return scanCache.result;
  }
  if (scanInFlight) {
    return scanInFlight;
  }

  scanInFlight = (async (): Promise<ScanResult> => {
    try {
      const res = await runScan();
      // Only cache if the anchor leg succeeded
      if (!res.venueErrors.veranta && res.counts.verantaMarkets > 0) {
        scanCache = { result: res, ts: Date.now() };
      }
      return res;
    } finally {
      scanInFlight = null;
    }
  })();

  return scanInFlight;
}

async function runScan(): Promise<ScanResult> {
  const verantaPromise = settle(fetchVerantaMarkets());

  const hedgeResultsPromise = Promise.all(
    HEDGE_VENUES.map(async (id) => {
      if (id === "grvt") {
        // Wait for Veranta first so GRVT only queries instruments that exist on Veranta
        const vRes = await verantaPromise;
        const allowed = new Set<string>();
        if (vRes.ok) {
          for (const m of vRes.value.values()) {
            const t = hedgeTickerFor("grvt", m.asset, m.klass);
            if (t) allowed.add(t);
          }
        }
        return { id, res: await settle(fetchGrvtMarkets(allowed)) };
      }
      return { id, res: await settle(HEDGE_FETCHERS[id]()) };
    }),
  );

  const [verantaRes, hedgeResults] = await Promise.all([
    verantaPromise,
    hedgeResultsPromise,
  ]);

  const venueErrors: Partial<Record<VenueId, string>> = {};

  const veranta = verantaRes.ok ? verantaRes.value : new Map<string, VerantaMarket>();
  if (!verantaRes.ok) venueErrors.veranta = verantaRes.error;

  const hedgeBooks: Array<{ id: HedgeVenueId; markets: Map<string, HedgeMarket> }> = [];
  const hedgeCounts: Partial<Record<HedgeVenueId, number>> = {};
  for (const { id, res } of hedgeResults) {
    if (res.ok) {
      hedgeBooks.push({ id, markets: res.value });
      hedgeCounts[id] = res.value.size;
    } else {
      venueErrors[id] = res.error;
    }
  }

  const assets: ScanAsset[] = [...veranta.values()].map((anchor) => {
    const hedges: ScanHedge[] = [];
    for (const { id, markets } of hedgeBooks) {
      const ticker = hedgeTickerFor(id, anchor.asset, anchor.klass);
      if (!ticker) continue;
      const market = markets.get(ticker);
      if (!market) continue;
      hedges.push({
        venue: market.venue,
        name: market.name,
        longDailyPct: market.longDailyPct,
        shortDailyPct: market.shortDailyPct,
        volume24hUsd: market.volume24hUsd,
        stale: market.stale,
      });
    }
    return {
      asset: anchor.asset,
      klass: anchor.klass,
      isOpen: anchor.isOpen,
      longDailyPct: anchor.longDailyPct,
      shortDailyPct: anchor.shortDailyPct,
      volume24hUsd: anchor.volume24hUsd,
      openInterestUsd: anchor.openInterestUsd,
      maxOpenInterestUsd: anchor.maxOpenInterestUsd,
      longOiUsd: anchor.longOiUsd,
      shortOiUsd: anchor.shortOiUsd,
      hedges,
    };
  });

  const { opportunities, blocked, matched } = rankAssets(assets);

  return {
    fetchedAt: new Date().toISOString(),
    opportunities,
    blocked,
    assets,
    counts: {
      verantaMarkets: veranta.size,
      hedgeMarkets: hedgeCounts,
      matched,
    },
    venueErrors,
  };
}
