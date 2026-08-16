import { NextResponse } from "next/server";

import { hedgeTickerFor } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  type AvantisMarket,
  type HedgeMarket,
  type HedgeVenueId,
  type VenueId,
} from "@/lib/types";
import { fetchAvantisMarkets } from "@/lib/venues/avantis";
import { fetchGrvtMarkets } from "@/lib/venues/grvt";
import { fetchOndoMarkets } from "@/lib/venues/ondo";
import { fetchPacificaMarkets } from "@/lib/venues/pacifica";
import { fetchVariationalMarkets } from "@/lib/venues/variational";

export const revalidate = 120;
export const maxDuration = 30;

const HEDGE_FETCHERS: Record<HedgeVenueId, () => Promise<Map<string, HedgeMarket>>> = {
  variational: fetchVariationalMarkets,
  ondo: fetchOndoMarkets,
  grvt: fetchGrvtMarkets,
  pacifica: fetchPacificaMarkets,
};

/**
 * Raw funding for every matched market. No pairing, no ranking.
 *
 * A row appears as soon as one hedge venue quotes the asset; venues that do
 * not list it are null rather than omitted, so the shape is stable per row.
 */
export async function GET() {
  const settled = await Promise.allSettled([
    fetchAvantisMarkets(),
    ...HEDGE_VENUES.map((v) => HEDGE_FETCHERS[v]()),
  ]);

  const errors: Partial<Record<VenueId, string>> = {};
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const avSettled = settled[0] as PromiseSettledResult<Map<string, AvantisMarket>>;
  const avantis = avSettled.status === "fulfilled" ? avSettled.value : new Map();
  if (avSettled.status === "rejected") errors.avantis = message(avSettled.reason);

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

  const assets = [...avantis.values()]
    .map((a) => {
      const hedges: Partial<Record<HedgeVenueId, HedgeMarket | null>> = {};
      let found = 0;
      for (const [venue, markets] of books) {
        const m = markets.get(hedgeTickerFor(venue, a.asset)) ?? null;
        hedges[venue] = m;
        if (m) found += 1;
      }
      return { asset: a.asset, klass: a.klass, avantis: a, hedges, found };
    })
    .filter((row) => row.found > 0)
    .map(({ found: _found, ...row }) => row)
    .sort((x, y) => x.asset.localeCompare(y.asset));

  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    counts: {
      avantisMarkets: avantis.size,
      hedgeMarkets: counts,
      matched: assets.length,
    },
    assets,
    venueErrors: errors,
  });
}
