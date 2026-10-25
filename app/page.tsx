import { Fragment } from "react";

import { Scanner } from "@/components/Scanner";
import { Venue } from "@/components/Venue";
import { scan } from "@/lib/strategy";
import { HEDGE_VENUES, VENUE_LABEL } from "@/lib/types";

export const revalidate = 60;
export const preferredRegion = ["fra1", "hnd1"];

export default async function Page() {
  const { assets, counts, venueErrors, fetchedAt } = await scan();

  return (
    <main className="shell">
      <Scanner assets={assets} venueErrors={venueErrors} fetchedAt={fetchedAt} />

      <footer>
        <div className="matchup">
          <Venue venue="veranta" size={22} />
          {HEDGE_VENUES.map((v) => (
            <Fragment key={v}>
              <span className="cross">×</span>
              <Venue venue={v} size={22} />
            </Fragment>
          ))}
        </div>

        <div className="footer-meta">
          <span>Veranta {counts.verantaMarkets}</span>
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
