"use client";

import { useMemo, useState } from "react";

import { OpportunityTable } from "@/components/OpportunityTable";
import { RefreshButton } from "@/components/RefreshButton";
import { Venue } from "@/components/Venue";
import { WithheldPanel } from "@/components/WithheldPanel";
import { bps, pct, utcStamp } from "@/lib/format";
import { listHedgeNames, rankAssets } from "@/lib/rank";
import { venueTradeUrl } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  VENUE_LABEL,
  type HedgeVenueId,
  type ScanAsset,
  type VenueId,
} from "@/lib/types";

type HedgePick = "all" | HedgeVenueId[];

export function Scanner({
  assets,
  venueErrors,
  fetchedAt,
}: {
  assets: ScanAsset[];
  venueErrors: Partial<Record<VenueId, string>>;
  fetchedAt: string;
}) {
  const [hedges, setHedges] = useState<HedgePick>("all");
  const allOn = hedges === "all";
  const venues: readonly HedgeVenueId[] = allOn ? HEDGE_VENUES : hedges;

  const rankedAll = useMemo(() => rankAssets(assets), [assets]);
  const ranked = useMemo(
    () => (allOn ? rankedAll : rankAssets(assets, hedges)),
    [allOn, assets, hedges, rankedAll],
  );

  const venuePayCounts = useMemo(() => {
    const counts = {} as Record<HedgeVenueId, number>;
    for (const v of HEDGE_VENUES) {
      counts[v] = rankAssets(assets, [v]).opportunities.length;
    }
    return counts;
  }, [assets]);

  const { opportunities, blocked } = ranked;
  const noEdge = blocked.filter((b) => b.reason === "no_edge");
  const hasVenueError = Object.keys(venueErrors).length > 0;

  const topApr =
    opportunities.length > 0
      ? opportunities.reduce((best, o) =>
          o.carryAprPct > best.carryAprPct ||
          (o.carryAprPct === best.carryAprPct && o.volume24hUsd > best.volume24hUsd)
            ? o
            : best,
        )
      : null;
  const topHedgeSide = topApr
    ? topApr.anchorSide === "long"
      ? "short"
      : "long"
    : "short";

  const toggleAll = () => setHedges("all");

  const toggleVenue = (v: HedgeVenueId) => {
    if (hedges === "all") {
      setHedges([v]);
      return;
    }
    const on = new Set(hedges);
    if (on.has(v)) on.delete(v);
    else on.add(v);
    if (on.size === 0 || on.size === HEDGE_VENUES.length) {
      setHedges("all");
      return;
    }
    setHedges(HEDGE_VENUES.filter((id) => on.has(id)));
  };

  return (
    <>
      <header className="masthead">
        <div className="masthead-left">
          <div className="clock">
            <span className={`pulse ${hasVenueError ? "stale" : ""}`}>
              {hasVenueError ? "Degraded" : "Live"}
            </span>
            <span>{utcStamp(fetchedAt)}</span>
            <RefreshButton />
          </div>
          <h1>Funding rate arbitrage</h1>
        </div>
        {topApr && (
          <div className="peak-apr">
            <div className="peak-lbl">Highest current APR</div>
            <div className="peak-val">
              <span className="apr">{pct(topApr.carryAprPct, 1)}</span>
              <span className="bps">{bps(topApr.netCarryBps, 2)} bps/24h</span>
            </div>
            <div className="peak-pair">
              <strong className="ticker">{topApr.asset}</strong>
              <a
                className={`leg-btn ${topApr.anchorSide}`}
                href={venueTradeUrl("veranta", topApr.asset, topApr.klass, topApr.anchorSide)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={`s ${topApr.anchorSide}`}>{topApr.anchorSide}</span>
                <Venue venue="veranta" size={12} />
              </a>
              <a
                className={`leg-btn ${topHedgeSide}`}
                href={venueTradeUrl(topApr.hedgeVenue, topApr.asset, topApr.klass, topHedgeSide)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={`s ${topHedgeSide}`}>{topHedgeSide}</span>
                <Venue venue={topApr.hedgeVenue} size={12} />
              </a>
            </div>
          </div>
        )}
      </header>

      {hasVenueError && (
        <div className="notice warn">
          <div className="title">A venue did not respond</div>
          <p>
            {Object.entries(venueErrors)
              .map(([v, e]) => `${VENUE_LABEL[v as keyof typeof VENUE_LABEL]}: ${e}`)
              .join(" · ")}
          </p>
        </div>
      )}

      <div className="controls hedge-picks">
        <span className="ctl-label">Hedge</span>
        <div className="chips">
          <button
            type="button"
            className="chip-btn"
            aria-pressed={allOn}
            onClick={toggleAll}
          >
            All<span className="count">{rankedAll.opportunities.length}</span>
          </button>
          {HEDGE_VENUES.map((v) => {
            const checked = !allOn && venues.includes(v);
            return (
              <button
                key={v}
                type="button"
                className="chip-btn"
                aria-pressed={checked}
                onClick={() => toggleVenue(v)}
              >
                <Venue venue={v} size={12} />
                <span className="count">{venuePayCounts[v]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {opportunities.length === 0 && (
        <div className="empty standalone">
          {hasVenueError && assets.length === 0
            ? "Venue data is unavailable, so nothing can be ranked right now."
            : noEdge.length > 0
              ? allOn
                ? "Nothing currently pays enough to cover the Veranta rate."
                : `Nothing currently pays enough to cover the Veranta rate against ${listHedgeNames(venues)}.`
              : allOn
                ? "No market is open on Veranta and a hedge venue at the same time."
                : `No market is open on Veranta and ${listHedgeNames(venues)} at the same time.`}
        </div>
      )}

      {opportunities.length > 0 && (
        <section className="table-section">
          <OpportunityTable
            key={allOn ? "all" : hedges.join(",")}
            rows={opportunities}
          />
        </section>
      )}

      {blocked.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Withheld</h2>
            <span className="section-badge">{blocked.length} markets</span>
          </div>
          <WithheldPanel blocked={blocked} hedges={venues} />
        </section>
      )}
    </>
  );
}
