import { NextResponse } from "next/server";

import { variationalTickerFor } from "@/lib/symbols";
import { fetchAvantisMarkets } from "@/lib/venues/avantis";
import { fetchVariationalMarkets } from "@/lib/venues/variational";
import type { AvantisMarket, VariationalMarket, VenueId } from "@/lib/types";

export const revalidate = 120;
export const maxDuration = 30;

/** Raw funding for every matched market. No pairing, no ranking. */
export async function GET() {
  const [av, va] = await Promise.allSettled([
    fetchAvantisMarkets(),
    fetchVariationalMarkets(),
  ]);

  const errors: Partial<Record<VenueId, string>> = {};

  const avantis =
    av.status === "fulfilled" ? av.value : new Map<string, AvantisMarket>();
  if (av.status === "rejected") errors.avantis = String(av.reason?.message ?? av.reason);

  const variational =
    va.status === "fulfilled" ? va.value : new Map<string, VariationalMarket>();
  if (va.status === "rejected") {
    errors.variational = String(va.reason?.message ?? va.reason);
  }

  const assets = [...avantis.values()]
    .map((a) => ({
      asset: a.asset,
      klass: a.klass,
      avantis: a,
      variational: variational.get(variationalTickerFor(a.asset).toUpperCase()) ?? null,
    }))
    .filter((row) => row.variational !== null)
    .sort((x, y) => x.asset.localeCompare(y.asset));

  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    counts: {
      avantisMarkets: avantis.size,
      variationalMarkets: variational.size,
      matched: assets.length,
    },
    assets,
    venueErrors: errors,
  });
}
