import { CLASS_LABEL, hedgeTickerFor, matchCaveatFor } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  VENUE_LABEL,
  type AvantisMarket,
  type Blocked,
  type HedgeMarket,
  type HedgeVenueId,
  type Opportunity,
  type ScanResult,
  type Side,
  type VenueId,
} from "@/lib/types";
import { fetchAvantisMarkets } from "@/lib/venues/avantis";
import { fetchGrvtMarkets } from "@/lib/venues/grvt";
import { fetchOndoMarkets } from "@/lib/venues/ondo";
import { fetchPacificaMarkets } from "@/lib/venues/pacifica";
import { fetchVariationalMarkets } from "@/lib/venues/variational";

/** How to load each hedge venue. Order here is the order shown in the UI. */
const HEDGE_FETCHERS: Record<HedgeVenueId, () => Promise<Map<string, HedgeMarket>>> = {
  variational: fetchVariationalMarkets,
  ondo: fetchOndoMarkets,
  grvt: fetchGrvtMarkets,
  pacifica: fetchPacificaMarkets,
};

/**
 * Net carry for one ordered pair, in basis points of notional per day.
 *
 * Rates are signed so positive means the trader pays. Holding both legs costs
 * the sum of the two, so what you earn is that sum negated. Positive result
 * means the position pays you.
 */
export function netCarryBps(longLegDailyPct: number, shortLegDailyPct: number): number {
  return -(longLegDailyPct + shortLegDailyPct) * 100;
}

export const aprFromBps = (bps: number): number => (bps * 365) / 100;

type PairCore = Pick<
  Opportunity,
  "asset" | "long" | "short" | "anchorSide" | "hedgeVenue" | "netCarryBps" | "carryAprPct"
>;

/**
 * Build the two Avantis-anchored candidates for one asset and keep the better.
 *
 * Avantis is a borrow-fee venue, so both of its sides are positive and it can
 * never be the leg that earns. Positive carry therefore requires the hedge to
 * pay more than the Avantis borrow fee costs.
 */
export function bestPair(anchor: AvantisMarket, hedge: HedgeMarket): PairCore {
  const candidates: Array<{ anchorSide: Side; longPct: number; shortPct: number }> = [
    // Long Avantis, short the hedge.
    { anchorSide: "long", longPct: anchor.longDailyPct, shortPct: hedge.shortDailyPct },
    // Long the hedge, short Avantis.
    { anchorSide: "short", longPct: hedge.longDailyPct, shortPct: anchor.shortDailyPct },
  ];

  let best = candidates[0];
  let bestBps = netCarryBps(best.longPct, best.shortPct);

  for (const c of candidates.slice(1)) {
    const bps = netCarryBps(c.longPct, c.shortPct);
    if (bps > bestBps) {
      best = c;
      bestBps = bps;
    }
  }

  const anchorIsLong = best.anchorSide === "long";

  return {
    asset: anchor.asset,
    long: {
      venue: anchorIsLong ? "avantis" : hedge.venue,
      side: "long",
      dailyPct: best.longPct,
    },
    short: {
      venue: anchorIsLong ? hedge.venue : "avantis",
      side: "short",
      dailyPct: best.shortPct,
    },
    anchorSide: best.anchorSide,
    hedgeVenue: hedge.venue,
    netCarryBps: bestBps,
    carryAprPct: aprFromBps(bestBps),
  };
}

/**
 * The best pair across every hedge venue that quotes this asset.
 *
 * Ties go to the deeper venue: two venues at the same rate are not the same
 * trade if only one of them can absorb the size.
 */
export function bestAcrossHedges(
  anchor: AvantisMarket,
  hedges: HedgeMarket[],
): { core: PairCore; hedge: HedgeMarket } | null {
  let winner: { core: PairCore; hedge: HedgeMarket } | null = null;

  for (const hedge of hedges) {
    const core = bestPair(anchor, hedge);
    if (
      !winner ||
      core.netCarryBps > winner.core.netCarryBps ||
      (core.netCarryBps === winner.core.netCarryBps &&
        hedge.volume24hUsd > winner.hedge.volume24hUsd)
    ) {
      winner = { core, hedge };
    }
  }

  return winner;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const listNames = (venues: HedgeVenueId[]): string =>
  venues.map((v) => VENUE_LABEL[v]).join(" and ");

export async function scan(): Promise<ScanResult> {
  const [avantisRes, hedgeResults] = await Promise.all([
    settle(fetchAvantisMarkets()),
    Promise.all(
      HEDGE_VENUES.map(async (id) => ({ id, res: await settle(HEDGE_FETCHERS[id]()) })),
    ),
  ]);

  const venueErrors: Partial<Record<VenueId, string>> = {};

  const avantis = avantisRes.ok ? avantisRes.value : new Map<string, AvantisMarket>();
  if (!avantisRes.ok) venueErrors.avantis = avantisRes.error;

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

  const opportunities: Opportunity[] = [];
  const blocked: Blocked[] = [];
  let matched = 0;

  for (const anchor of avantis.values()) {
    const listings = hedgeBooks.flatMap(({ id, markets }) => {
      const market = markets.get(hedgeTickerFor(id, anchor.asset));
      return market ? [market] : [];
    });

    if (listings.length === 0) {
      blocked.push({
        asset: anchor.asset,
        label: anchor.asset,
        klass: anchor.klass,
        reason: "not_listed_hedge",
        detail: `Avantis lists it as ${CLASS_LABEL[anchor.klass]}, no matching market on ${listNames(
          hedgeBooks.map((h) => h.id),
        )}`,
      });
      continue;
    }

    matched += 1;

    // Label from the deepest venue that quotes it, so the name survives even
    // when the pair itself is withheld.
    const label =
      [...listings].sort((a, b) => b.volume24hUsd - a.volume24hUsd)[0]?.name ??
      anchor.asset;

    if (!anchor.isOpen) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "anchor_closed",
        detail: "Avantis reports the feed outside its trading calendar",
      });
      continue;
    }

    const live = listings.filter((m) => !m.stale);
    if (live.length === 0) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "hedge_closed",
        detail: `Funding is exactly zero on ${listNames(
          listings.map((m) => m.venue),
        )}, meaning the market is shut or the rate was voided`,
      });
      continue;
    }

    const winner = bestAcrossHedges(anchor, live);
    if (!winner) continue;

    const opp: Opportunity = {
      ...winner.core,
      label: winner.hedge.name,
      klass: anchor.klass,
      volume24hUsd: anchor.volume24hUsd,
      hedgeVolume24hUsd: winner.hedge.volume24hUsd,
      avantisOiUtil:
        anchor.maxOpenInterestUsd > 0
          ? anchor.openInterestUsd / anchor.maxOpenInterestUsd
          : 0,
      caveat: matchCaveatFor(winner.hedge.venue, anchor.asset),
    };

    // Every Avantis direction costs more than any hedge pays, so there is no
    // trade here — only the inverse, which the anchor rule does not allow.
    if (opp.netCarryBps <= 0) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "no_edge",
        detail: `Best of ${live.length} hedge${
          live.length === 1 ? "" : "s"
        } still costs ${(-opp.netCarryBps).toFixed(2)} bp a day`,
      });
      continue;
    }

    opportunities.push(opp);
  }

  // Depth first: everything left pays, so the question is what size it takes.
  // Avantis trades nothing at all in most of its markets, so ties on zero
  // volume fall back to the rate.
  opportunities.sort(
    (a, b) => b.volume24hUsd - a.volume24hUsd || b.netCarryBps - a.netCarryBps,
  );
  blocked.sort((a, b) => a.asset.localeCompare(b.asset));

  return {
    fetchedAt: new Date().toISOString(),
    opportunities,
    blocked,
    counts: {
      avantisMarkets: avantis.size,
      hedgeMarkets: hedgeCounts,
      matched,
    },
    venueErrors,
  };
}
