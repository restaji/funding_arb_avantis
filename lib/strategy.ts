import {
  CLASS_LABEL,
  MATCH_CAVEATS,
  variationalTickerFor,
} from "@/lib/symbols";
import {
  type AvantisMarket,
  type Blocked,
  type Opportunity,
  type ScanResult,
  type Side,
  type VariationalMarket,
  type VenueId,
} from "@/lib/types";
import { fetchAvantisMarkets } from "@/lib/venues/avantis";
import { fetchVariationalMarkets } from "@/lib/venues/variational";

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

/**
 * Build the two Avantis-anchored candidates for one asset and keep the better.
 *
 * Avantis is a borrow-fee venue, so both of its sides are positive and it can
 * never be the leg that earns. Positive carry therefore requires Variational
 * to pay more than the Avantis borrow fee costs.
 */
export function bestPair(
  anchor: AvantisMarket,
  hedge: VariationalMarket,
): Omit<Opportunity, "label" | "klass" | "volume24hUsd" | "avantisOiUtil" | "caveat"> {
  const candidates: Array<{ anchorSide: Side; longPct: number; shortPct: number }> = [
    // Long Avantis, short Variational.
    { anchorSide: "long", longPct: anchor.longDailyPct, shortPct: hedge.shortDailyPct },
    // Long Variational, short Avantis.
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
      venue: anchorIsLong ? "avantis" : "variational",
      side: "long",
      dailyPct: best.longPct,
    },
    short: {
      venue: anchorIsLong ? "variational" : "avantis",
      side: "short",
      dailyPct: best.shortPct,
    },
    anchorSide: best.anchorSide,
    netCarryBps: bestBps,
    carryAprPct: aprFromBps(bestBps),
  };
}

export async function scan(): Promise<ScanResult> {
  const [avRes, vaRes] = await Promise.allSettled([
    fetchAvantisMarkets(),
    fetchVariationalMarkets(),
  ]);

  const venueErrors: Partial<Record<VenueId, string>> = {};

  const avantis =
    avRes.status === "fulfilled" ? avRes.value : new Map<string, AvantisMarket>();
  if (avRes.status === "rejected") {
    venueErrors.avantis = String(avRes.reason?.message ?? avRes.reason);
  }

  const variational =
    vaRes.status === "fulfilled" ? vaRes.value : new Map<string, VariationalMarket>();
  if (vaRes.status === "rejected") {
    venueErrors.variational = String(vaRes.reason?.message ?? vaRes.reason);
  }

  const opportunities: Opportunity[] = [];
  const blocked: Blocked[] = [];
  let matched = 0;

  for (const anchor of avantis.values()) {
    const hedge = variational.get(variationalTickerFor(anchor.asset).toUpperCase());
    const label = hedge?.name ?? anchor.asset;

    if (!hedge) {
      blocked.push({
        asset: anchor.asset,
        label: anchor.asset,
        klass: anchor.klass,
        reason: "not_listed_variational",
        detail: `Avantis lists it as ${CLASS_LABEL[anchor.klass]}, Variational has no matching market`,
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
        detail: "Avantis reports the feed outside its trading calendar",
      });
      continue;
    }
    if (hedge.stale) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "hedge_closed",
        detail: "Variational funding is exactly zero, meaning the market is shut",
      });
      continue;
    }
    const opp: Opportunity = {
      ...bestPair(anchor, hedge),
      label,
      klass: anchor.klass,
      volume24hUsd: anchor.volume24hUsd,
      avantisOiUtil:
        anchor.maxOpenInterestUsd > 0
          ? anchor.openInterestUsd / anchor.maxOpenInterestUsd
          : 0,
      caveat: MATCH_CAVEATS[anchor.asset],
    };

    // Both Avantis directions cost more than Variational pays, so there is no
    // trade here — only the inverse, which the anchor rule does not allow.
    if (opp.netCarryBps <= 0) {
      blocked.push({
        asset: anchor.asset,
        label,
        klass: anchor.klass,
        reason: "no_edge",
        detail: `Better direction still costs ${(-opp.netCarryBps).toFixed(2)} bp a day`,
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
      variationalMarkets: variational.size,
      matched,
    },
    venueErrors,
  };
}
