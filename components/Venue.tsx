import { VENUE_LABEL, type VenueId } from "@/lib/types";

/** Avantis violet, Variational blue, Ondo teal, GRVT amber, Pacifica sky. */
const TONE: Record<VenueId, string> = {
  avantis: "av",
  variational: "va",
  ondo: "on",
  grvt: "gr",
  pacifica: "pa",
};

const ICON: Record<VenueId, string> = {
  avantis: "/venues/avantis.png",
  variational: "/venues/variational.png",
  ondo: "/venues/ondo.svg",
  grvt: "/venues/grvt.png",
  pacifica: "/venues/pacifica.svg",
};

/**
 * Venue mark plus name. Size is the mark's edge in px: the table runs small
 * enough that the colour does most of the identifying.
 */
export function Venue({ venue, size = 13 }: { venue: VenueId; size?: number }) {
  return (
    <span className={`venue ${TONE[venue]}`}>
      <img
        className="mark"
        src={ICON[venue]}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
      {VENUE_LABEL[venue]}
    </span>
  );
}

export const venueTone = (venue: VenueId): string => TONE[venue];
