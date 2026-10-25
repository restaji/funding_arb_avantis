import { NextResponse } from "next/server";

import { hedgeTickerFor } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  type HedgeMarket,
  type HedgeVenueId,
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

export const revalidate = 60;
export const maxDuration = 30;

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

/**
 * Raw funding for every matched market. No pairing, no ranking.
 *
 * A row appears as soon as one hedge venue quotes the asset; venues that do
 * not list it are null rather than omitted, so the shape is stable per row.
 */
export async function GET() {
  const vePromise = fetchVerantaMarkets();

  const settled = await Promise.allSettled([
    vePromise,
    ...HEDGE_VENUES.map(async (v) => {
      if (v === "grvt") {
        const verantaMap = await vePromise.catch(() => new Map<string, VerantaMarket>());
        const allowed = new Set<string>();
        for (const m of verantaMap.values()) {
          const t = hedgeTickerFor("grvt", m.asset, m.klass);
          if (t) allowed.add(t);
        }
        return fetchGrvtMarkets(allowed);
      }
      return HEDGE_FETCHERS[v]();
    }),
  ]);

  const errors: Partial<Record<VenueId, string>> = {};
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const veSettled = settled[0] as PromiseSettledResult<Map<string, VerantaMarket>>;
  const veranta = veSettled.status === "fulfilled" ? veSettled.value : new Map();
  if (veSettled.status === "rejected") errors.veranta = message(veSettled.reason);

  const books = new Map<HedgeVenueId, Map<string, HedgeMarket>>();
  const counts: Partial<Record<HedgeVenueId, number>> = {};

  HEDGE_VENUES.forEach((venue, i) => {
    const res = settled[i + 1] as PromiseSettledResult<Map<string, HedgeMarket>>;
    if (res.status === "fulfilled") {
      books.set(venue, res.value);
      counts[venue] = res.value.size;
    } else {
      errors[venue] = message(res.reason);
    }
  });

  const assets = [...veranta.values()]
    .map((a) => {
      const hedges: Partial<Record<HedgeVenueId, HedgeMarket | null>> = {};
      let found = 0;
      for (const [venue, markets] of books) {
        const m = markets.get(hedgeTickerFor(venue, a.asset, a.klass)) ?? null;
        hedges[venue] = m;
        if (m) found += 1;
      }
      return { asset: a.asset, klass: a.klass, veranta: a, hedges, found };
    })
    .filter((row) => row.found > 0)
    .map(({ found: _found, ...row }) => row)
    .sort((x, y) => x.asset.localeCompare(y.asset));

  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    counts: {
      verantaMarkets: veranta.size,
      hedgeMarkets: counts,
      matched: assets.length,
    },
    assets,
    venueErrors: errors,
  });
}
