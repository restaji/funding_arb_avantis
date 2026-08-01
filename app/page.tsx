import { OpportunityTable } from "@/components/OpportunityTable";
import { RefreshButton } from "@/components/RefreshButton";
import { Venue } from "@/components/Venue";
import { WithheldPanel } from "@/components/WithheldPanel";
import { utcStamp } from "@/lib/format";
import { scan } from "@/lib/strategy";
import { HEDGE_VENUES, VENUE_LABEL } from "@/lib/types";

export const revalidate = 120;

export default async function Page() {
  const { opportunities, blocked, counts, venueErrors, fetchedAt } = await scan();

  const noEdge = blocked.filter((b) => b.reason === "no_edge");
  const hasVenueError = Object.keys(venueErrors).length > 0;

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brandbar">
          <div className="clock">
            <span className={`pulse ${hasVenueError ? "stale" : ""}`}>
              {hasVenueError ? "Degraded" : "Live"}
            </span>
            <span>{utcStamp(fetchedAt)}</span>
          </div>
        </div>

        <div className="title-row">
          <h1>Funding rate arbitrage</h1>
          <RefreshButton />
        </div>
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

      {opportunities.length === 0 && (
        <div className="empty standalone">
          {hasVenueError
            ? "Venue data is unavailable, so nothing can be ranked right now."
            : noEdge.length > 0
              ? "Nothing currently pays enough to cover the Avantis fee."
              : "No market is open on Avantis and a hedge venue at the same time."}
        </div>
      )}

      {opportunities.length > 0 && (
        <section>
          <OpportunityTable rows={opportunities} />
        </section>
      )}

      {blocked.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Withheld</h2>
            <span className="section-badge">{blocked.length} markets</span>
          </div>
          <WithheldPanel blocked={blocked} />
        </section>
      )}

      <footer>
        <div className="matchup">
          <Venue venue="avantis" size={22} />
          <span className="cross">×</span>
          {HEDGE_VENUES.map((v, i) => (
            <span className="matchup-alt" key={v}>
              {i > 0 && <span className="or">or</span>}
              <Venue venue={v} size={22} />
            </span>
          ))}
        </div>

        <div className="footer-meta">
          <span>Avantis {counts.avantisMarkets}</span>
          {HEDGE_VENUES.filter((v) => counts.hedgeMarkets[v] !== undefined).map((v) => (
            <span key={v}>
              <span className="dot">/</span>
              {VENUE_LABEL[v]} {counts.hedgeMarkets[v]}
            </span>
          ))}
          <span className="dot">/</span>
          <span>{counts.matched} matched</span>
          <span className="dot">/</span>
          <code>/api/funding</code>
          <code>/api/opportunities</code>
        </div>
      </footer>
    </main>
  );
}
