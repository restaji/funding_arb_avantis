import { VENUE_LABEL, type VenueId } from "@/lib/types";

const TONE: Record<VenueId, string> = {
  veranta: "av",
  hyperliquid: "hl",
  lighter: "lt",
  ostium: "os",
  variational: "va",
  ondo: "on",
  grvt: "gr",
  pacifica: "pa",
  jupiter: "ju",
  antarctic: "ax",
  binance: "bn",
  bybit: "bb",
  okx: "ok",
  gate: "gt",
};

const ICON: Record<VenueId, string> = {
  veranta: "/venues/veranta.png",
  hyperliquid: "/venues/hyperliquid.svg",
  lighter: "/venues/lighter.svg",
  ostium: "/venues/ostium.svg",
  variational: "/venues/variational.png",
  ondo: "/venues/ondo.svg",
  grvt: "/venues/grvt.png",
  pacifica: "/venues/pacifica.svg",
  jupiter: "/venues/jupiter.png",
  antarctic: "/venues/antarctic.svg",
  binance: "/venues/binance.svg",
  bybit: "/venues/bybit.svg",
  okx: "/venues/okx.svg",
  gate: "/venues/gate.svg",
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

export const venueTone = (venue: VenueId): string => TONE[venue] ?? venue;
