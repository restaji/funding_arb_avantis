import type { AssetClass } from "@/lib/symbols";

export type VenueId =
  | "veranta"
  | "hyperliquid"
  | "lighter"
  | "ostium"
  | "variational"
  | "ondo"
  | "grvt"
  | "pacifica"
  | "jupiter"
  | "antarctic"
  | "binance"
  | "bybit"
  | "okx"
  | "gate";
export type Side = "long" | "short";

/** Veranta must sit on exactly one leg of every candidate pair. */
export const ANCHOR_VENUE: VenueId = "veranta";

/**
 * The venues Veranta can be hedged against, tried in this order.
 *
 * Every asset is scored against all of them and only the best-paying pair
 * survives, so adding a venue here can only improve a row, never remove one.
 */
export const HEDGE_VENUES = [
  "hyperliquid",
  "lighter",
  "ostium",
  "variational",
  "ondo",
  "grvt",
  "pacifica",
  "jupiter",
  "antarctic",
  "binance",
  "bybit",
  "okx",
  "gate",
] as const;
export type HedgeVenueId = (typeof HEDGE_VENUES)[number];

export const VENUE_LABEL: Record<VenueId, string> = {
  veranta: "Veranta",
  hyperliquid: "Hyperliquid",
  lighter: "Lighter",
  ostium: "Ostium",
  variational: "Variational",
  ondo: "Ondo Perps",
  grvt: "GRVT",
  pacifica: "Pacifica",
  jupiter: "Jupiter",
  antarctic: "Antarctic",
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  gate: "Gate",
};

/**
 * One venue's funding for one asset, both sides.
 *
 * Sign convention throughout: positive means the trader PAYS.
 */
export interface VenueFunding {
  venue: VenueId;
  /** Canonical asset key (the Veranta base symbol). */
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

export interface VerantaMarket extends VenueFunding {
  pairIndex: number;
  klass: AssetClass;
  /** Veranta publishes a trading calendar per feed. Crypto is always true. */
  isOpen: boolean;
  openInterestUsd: number;
  maxOpenInterestUsd: number;
  /** Veranta long open interest, USDC notional. */
  longOiUsd: number;
  /** Veranta short open interest, USDC notional. */
  shortOiUsd: number;
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
  /** Veranta 24h volume, the liquidity reference for the whole pair. */
  volume24hUsd: number;
  /** 24h volume on the winning hedge venue, which caps the pair just as hard. */
  hedgeVolume24hUsd: number;
  /** Fraction of the Veranta pair's OI cap already used, 0..1. */
  verantaOiUtil: number;
  verantaLongOiUsd: number;
  verantaShortOiUsd: number;
  caveat?: string;
}

/** Splits a pair into its Veranta leg and its hedge leg. */
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

/** One hedge venue's quote on a Veranta asset, enough to re-pair on the client. */
export interface ScanHedge {
  venue: HedgeVenueId;
  name: string;
  longDailyPct: number;
  shortDailyPct: number;
  volume24hUsd: number;
  stale: boolean;
}

/**
 * One Veranta market plus every hedge that quotes it.
 *
 * The board re-ranks this set when the venue checklist changes, so a
 * Hyperliquid-only filter can surface a pair that lost to Variational
 * in the all-venues ranking.
 */
export interface ScanAsset {
  asset: string;
  klass: AssetClass;
  isOpen: boolean;
  longDailyPct: number;
  shortDailyPct: number;
  volume24hUsd: number;
  openInterestUsd: number;
  maxOpenInterestUsd: number;
  longOiUsd: number;
  shortOiUsd: number;
  hedges: ScanHedge[];
}

export interface ScanResult {
  fetchedAt: string;
  /** Every pair that pays, deepest Veranta volume first. */
  opportunities: Opportunity[];
  /** Withheld: no candidate pair to build, or no edge in the one there is. */
  blocked: Blocked[];
  /** Raw per-asset quotes; the UI re-ranks these against the venue checklist. */
  assets: ScanAsset[];
  counts: {
    verantaMarkets: number;
    /** Listing count per hedge venue. A venue that errored is absent. */
    hedgeMarkets: Partial<Record<HedgeVenueId, number>>;
    matched: number;
  };
  venueErrors: Partial<Record<VenueId, string>>;
}
