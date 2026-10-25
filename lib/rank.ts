import { CLASS_LABEL, matchCaveatFor } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  VENUE_LABEL,
  type Blocked,
  type HedgeVenueId,
  type Opportunity,
  type ScanAsset,
  type ScanHedge,
  type Side,
} from "@/lib/types";

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

type PairAnchor = Pick<ScanAsset, "asset" | "longDailyPct" | "shortDailyPct">;
type PairHedge = Pick<
  ScanHedge,
  "venue" | "name" | "longDailyPct" | "shortDailyPct" | "volume24hUsd"
>;

/**
 * Build the two Veranta-anchored candidates for one asset and keep the better.
 */
export function bestPair(anchor: PairAnchor, hedge: PairHedge): PairCore {
  const candidates: Array<{ anchorSide: Side; longPct: number; shortPct: number }> = [
    { anchorSide: "long", longPct: anchor.longDailyPct, shortPct: hedge.shortDailyPct },
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
      venue: anchorIsLong ? "veranta" : hedge.venue,
      side: "long",
      dailyPct: best.longPct,
    },
    short: {
      venue: anchorIsLong ? hedge.venue : "veranta",
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
 * The best pair across the given hedge quotes for this asset.
 *
 * Ties go to the deeper venue: two venues at the same rate are not the same
 * trade if only one of them can absorb the size.
 */
export function bestAcrossHedges(
  anchor: PairAnchor,
  hedges: PairHedge[],
): { core: PairCore; hedge: PairHedge } | null {
  let winner: { core: PairCore; hedge: PairHedge } | null = null;

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

export const listHedgeNames = (venues: readonly HedgeVenueId[]): string =>
  venues.map((v) => VENUE_LABEL[v]).join(" and ");

/**
 * Rank Veranta-anchored pairs against a hedge set.
 *
 * Pass every hedge venue for the default board; pass `[hyperliquid]` to
 * score Veranta against Hyperliquid only.
 */
export function rankAssets(
  assets: ScanAsset[],
  hedgeVenues: readonly HedgeVenueId[] = HEDGE_VENUES,
): { opportunities: Opportunity[]; blocked: Blocked[]; matched: number } {
  const allowed = new Set(hedgeVenues);
  const opportunities: Opportunity[] = [];
  const blocked: Blocked[] = [];
  let matched = 0;

  for (const anchor of assets) {
    const listings = anchor.hedges.filter((h) => allowed.has(h.venue));
    const label =
      [...listings].sort((a, b) => b.volume24hUsd - a.volume24hUsd)[0]?.name ??
      anchor.asset;

    if (listings.length === 0) {
      blocked.push({
        asset: anchor.asset,
        label: anchor.asset,
        klass: anchor.klass,
        reason: "not_listed_hedge",
        detail: `Veranta lists it as ${CLASS_LABEL[anchor.klass]}, no matching market on ${listHedgeNames(
          hedgeVenues,
        )}`,
      });
      continue;
    }

    matched += 1;

    if (!anchor.isOpen) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "anchor_closed",
        detail: "Veranta reports the feed outside its trading calendar",
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
        detail: `Funding is exactly zero on ${listHedgeNames(
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
      verantaOiUtil:
        anchor.maxOpenInterestUsd > 0
          ? anchor.openInterestUsd / anchor.maxOpenInterestUsd
          : 0,
      verantaLongOiUsd: anchor.longOiUsd,
      verantaShortOiUsd: anchor.shortOiUsd,
      caveat: matchCaveatFor(winner.hedge.venue, anchor.asset),
    };

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

  opportunities.sort(
    (a, b) => b.volume24hUsd - a.volume24hUsd || b.netCarryBps - a.netCarryBps,
  );
  blocked.sort((a, b) => a.asset.localeCompare(b.asset));

  return { opportunities, blocked, matched };
}
