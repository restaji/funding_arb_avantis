import { Venue, venueTone } from "@/components/Venue";
import { bps, earnClass, pct, share, usd } from "@/lib/format";
import { CLASS_LABEL } from "@/lib/symbols";
import {
  legsOf,
  VENUE_LABEL,
  type Opportunity,
  type Side,
  type VenueId,
} from "@/lib/types";

const SIDE_WORD = { long: "Long", short: "Short" } as const;

function LegRow({
  venue,
  side,
  dailyPct,
}: {
  venue: VenueId;
  side: Side;
  dailyPct: number;
}) {
  return (
    <div className={`leg ${venueTone(venue)}`}>
      <span className={`side ${side}`}>{SIDE_WORD[side]}</span>
      <Venue venue={venue} size={17} />
      <span className="leg-num">
        {bps(dailyPct * 100, 2)}
        <span className="unit"> bps/day</span>
      </span>
    </div>
  );
}

/** The deepest pair that pays, spelled out leg by leg. */
export function LeadCard({
  o,
  total,
}: {
  o: Opportunity;
  total: number;
}) {
  const { anchor, hedge } = legsOf(o);

  return (
    <article className="lead">
      <div className="lead-top">
        <span className="rank">Deepest market that pays</span>
        <span className="of">1 of {total} doable</span>
      </div>

      <div className="lead-id">
        <h2 className="lead-ticker">{o.asset}</h2>
        <span className="lead-name">{o.label}</span>
        <span className="klass">{CLASS_LABEL[o.klass]}</span>
      </div>

      <div className="legs">
        <LegRow venue="avantis" side={o.anchorSide} dailyPct={anchor.dailyPct} />
        <LegRow
          venue={o.hedgeVenue}
          side={o.anchorSide === "long" ? "short" : "long"}
          dailyPct={hedge.dailyPct}
        />
      </div>

      <div className="lead-net">
        <div className="cell">
          <div className={`big ${earnClass(o.netCarryBps)}`}>{bps(o.netCarryBps, 2)}</div>
          <div className="lbl">Net bps per day</div>
        </div>
        <div className="cell">
          <div className={`big ${earnClass(o.carryAprPct)}`}>{pct(o.carryAprPct, 1)}</div>
          <div className="lbl">Annualized flat</div>
        </div>
      </div>

      <div className="lead-foot">
        <span>{usd(o.volume24hUsd)} Avantis 24h volume</span>
        <span className="dot">·</span>
        <span>
          {usd(o.hedgeVolume24hUsd)} {VENUE_LABEL[o.hedgeVenue]} 24h volume
        </span>
        <span className="dot">·</span>
        <span>{share(o.avantisOiUtil, 1)} of the Avantis OI cap used</span>
        {o.caveat && (
          <>
            <span className="dot">·</span>
            <span title={o.caveat}>approximate match</span>
          </>
        )}
      </div>
    </article>
  );
}
