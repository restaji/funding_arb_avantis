/**
 * Asset identity across venues.
 *
 * The universe is not a hardcoded list. Avantis publishes a Pyth-style symbol
 * on every pair (`feed.attributes.symbol`, e.g. "Crypto.BTC/USD"), so the
 * tradeable set is derived at runtime as the intersection of what Avantis
 * lists and what any hedge venue lists. New listings on either side appear
 * without a code change.
 *
 * Only the cases where two venues genuinely disagree on naming need an
 * override.
 */

import type { HedgeVenueId } from "@/lib/types";

export type AssetClass = "crypto" | "equity" | "commodity" | "metal" | "fx" | "other";

export interface ParsedSymbol {
  /** Canonical key, taken from the Avantis base since Avantis anchors every pair. */
  base: string;
  klass: AssetClass;
}

const CLASS_BY_PREFIX: Record<string, AssetClass> = {
  crypto: "crypto",
  equity: "equity",
  commodities: "commodity",
  commodity: "commodity",
  metal: "metal",
  fx: "fx",
};

/**
 * "Crypto.BTC/USD"        -> { base: "BTC",     klass: "crypto" }
 * "Equity.US.SPY/USD"     -> { base: "SPY",     klass: "equity" }
 * "Commodities.WTIU6/USD" -> { base: "WTIU6",   klass: "commodity" }
 * "FX.EUR/USD"            -> { base: "EURUSD",  klass: "fx" }
 */
export function parseAvantisSymbol(symbol: string | undefined): ParsedSymbol | null {
  if (!symbol) return null;
  const parts = symbol.split(".");
  if (parts.length < 2) return null;

  const klass = CLASS_BY_PREFIX[parts[0].toLowerCase()] ?? "other";
  const pair = parts[parts.length - 1];
  if (!pair.includes("/")) return null;

  const [left, right] = pair.split("/");
  if (!left) return null;

  // FX quotes both sides, so the pair itself is the identity.
  const base = klass === "fx" ? `${left}${right}` : left;
  return { base: base.toUpperCase(), klass };
}

/**
 * Avantis base -> hedge venue ticker, only where plain equality fails.
 *
 * Variational: the 1000x contracts are a denomination difference, not an asset
 * difference. Funding is a percentage of notional, so it is invariant to the
 * contract multiplier and the match is exact for our purposes. SPY maps to
 * US500, which despite the index-sounding ticker is Variational's listing of
 * the SPDR S&P 500 ETF itself, marked around 742 like the ETF. Do not be
 * tempted by Variational's SPX: that is SPX6900, a memecoin.
 *
 * Ondo: lists no crypto beyond BTC and ETH, so the 1000x cases never arise.
 * It quotes generic WTI and Brent rather than a dated contract, and carries
 * SPY and QQQ under their own tickers, so SPY needs no redirect the way it
 * does on Variational. Ondo's US500 is the index, not the ETF.
 */
export const HEDGE_OVERRIDES: Record<HedgeVenueId, Record<string, string>> = {
  variational: {
    WTIU6: "CL",
    WTIM6: "CL",
    BRENTV6: "BZ",
    SPY: "US500",
    BONK: "1000BONK",
    PEPE: "1000PEPE",
    PUMP: "PUMPFUN",
    GOOG: "GOOGL",
    BB: "BBX",
  },
  ondo: {
    WTIU6: "WTI",
    WTIM6: "WTI",
    BRENTV6: "BRENT",
    GOOG: "GOOGL",
  },
};

/**
 * Matches that are close enough to hedge but not the identical instrument.
 * Surfaced in the UI rather than hidden.
 */
export const MATCH_CAVEATS: Record<HedgeVenueId, Record<string, string>> = {
  variational: {
    GOOG: "Avantis lists Alphabet Class C, Variational lists Class A (GOOGL) — near but not identical",
    WTIM6: "Avantis prices a specific WTI futures expiry, Variational quotes generic WTI",
    WTIU6: "Avantis prices a specific WTI futures expiry, Variational quotes generic WTI",
    BRENTV6:
      "Avantis prices a specific Brent futures expiry, Variational quotes generic Brent",
  },
  ondo: {
    GOOG: "Avantis lists Alphabet Class C, Ondo lists Class A (GOOGL) — near but not identical",
    WTIM6: "Avantis prices a specific WTI futures expiry, Ondo quotes generic WTI",
    WTIU6: "Avantis prices a specific WTI futures expiry, Ondo quotes generic WTI",
    BRENTV6: "Avantis prices a specific Brent futures expiry, Ondo quotes generic Brent",
  },
};

export function hedgeTickerFor(venue: HedgeVenueId, avantisBase: string): string {
  return (HEDGE_OVERRIDES[venue][avantisBase] ?? avantisBase).toUpperCase();
}

export function matchCaveatFor(
  venue: HedgeVenueId,
  avantisBase: string,
): string | undefined {
  return MATCH_CAVEATS[venue][avantisBase];
}

export const CLASS_LABEL: Record<AssetClass, string> = {
  crypto: "Crypto",
  equity: "Equity",
  commodity: "Commodity",
  metal: "Metal",
  fx: "FX",
  other: "Other",
};

/** Order used for grouping in the UI. */
export const CLASS_ORDER: AssetClass[] = [
  "crypto",
  "equity",
  "commodity",
  "metal",
  "fx",
  "other",
];
