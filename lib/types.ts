import type { AssetClass } from "@/lib/symbols";

export type VenueId = "avantis" | "variational" | "ondo" | "grvt" | "pacifica";
export type Side = "long" | "short";

/** Avantis must sit on exactly one leg of every candidate pair. */
export const ANCHOR_VENUE: VenueId = "avantis";

/**
 * The venues Avantis can be hedged against, tried in this order.
 *
 * Every asset is scored against all of them and only the best-paying pair
 * survives, so adding a venue here can only improve a row, never remove one.
 */
export const HEDGE_VENUES = ["variational", "ondo", "grvt", "pacifica"] as const;
export type HedgeVenueId = (typeof HEDGE_VENUES)[number];

export const VENUE_LABEL: Record<VenueId, string> = {
  avantis: "Avantis",
  variational: "Variational",
  ondo: "Ondo Perps",
  grvt: "GRVT",
  pacifica: "Pacifica",
};

/**
 * One venue's funding for one asset, both sides.
 *
 * Sign convention throughout: positive means the trader PAYS.
 */
export interface VenueFunding {
  venue: VenueId;
  /** Canonical asset key (the Avantis base symbol). */
  asset: string;
  /** Venue-native market identifier. */
  market: string;
  /** Daily % of notional, positive = pay. */
  longDailyPct: number;
  shortDailyPct: number;
  fundingIntervalS: number;
  /** Exact-zero rate, which on a scheduled market means closed rather than free. */
  stale: boolean;
}

export interface AvantisMarket extends VenueFunding {
  pairIndex: number;
  klass: AssetClass;
  /** Avantis publishes a trading calendar per feed. Crypto is always true. */
  isOpen: boolean;
  openInterestUsd: number;
  maxOpenInterestUsd: number;
  /** Traded notional over the last day. Absent from the feed means no flow. */
  volume24hUsd: number;
}

/**
 * The shape every hedge venue has to produce.
 *
 * The pairing logic only ever reads these fields, so a new venue is a fetcher
 * that fills them in plus an entry in HEDGE_VENUES.
 */
export interface HedgeMarket extends VenueFunding {
  venue: HedgeVenueId;
  /** The venue's own human name for the asset, used as the row label. */
  name: string;
  volume24hUsd: number;
  openInterestUsd: number;
}

export type VariationalMarket = HedgeMarket;

export interface OndoMarket extends HedgeMarket {
  /**
   * The underlying cash market is shut. Ondo keeps trading and keeps charging
   * funding regardless, so this is a caveat on the rate rather than a block.
   */
  underlyingClosed: boolean;
}

export interface Leg {
  venue: VenueId;
  side: Side;
  /** Daily % of notional for this leg, positive = pay. */
  dailyPct: number;
}

export interface Opportunity {
  asset: string;
  label: string;
  klass: AssetClass;
  long: Leg;
  short: Leg;
  anchorSide: Side;
  /** Which venue won the hedge leg, out of everything that quoted this asset. */
  hedgeVenue: HedgeVenueId;
  /** Daily carry in basis points of notional, positive = you earn. */
  netCarryBps: number;
  carryAprPct: number;
  /** Avantis 24h volume, the liquidity reference for the whole pair. */
  volume24hUsd: number;
  /** 24h volume on the winning hedge venue, which caps the pair just as hard. */
  hedgeVolume24hUsd: number;
  /** Fraction of the Avantis pair's OI cap already used, 0..1. */
  avantisOiUtil: number;
  caveat?: string;
}

/** Splits a pair into its Avantis leg and its hedge leg. */
export function legsOf(o: Opportunity): { anchor: Leg; hedge: Leg } {
  return o.anchorSide === "long"
    ? { anchor: o.long, hedge: o.short }
    : { anchor: o.short, hedge: o.long };
}

export type BlockedReason =
  | "anchor_closed"
  | "hedge_closed"
  | "no_edge"
  | "not_listed_hedge";

export interface Blocked {
  asset: string;
  label: string;
  klass: AssetClass;
  reason: BlockedReason;
  detail: string;
}

export interface ScanResult {
  fetchedAt: string;
  /** Every pair that pays, deepest Avantis volume first. */
  opportunities: Opportunity[];
  /** Withheld: no candidate pair to build, or no edge in the one there is. */
  blocked: Blocked[];
  counts: {
    avantisMarkets: number;
    /** Listing count per hedge venue. A venue that errored is absent. */
    hedgeMarkets: Partial<Record<HedgeVenueId, number>>;
    matched: number;
  };
  venueErrors: Partial<Record<VenueId, string>>;
}
