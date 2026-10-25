/**
 * Asset identity across venues.
 *
 * The universe is not a hardcoded list. Veranta publishes a Pyth-style symbol
 * on every pair (`feed.attributes.symbol`, e.g. "Crypto.BTC/USD"), so the
 * tradeable set is derived at runtime as the intersection of what Veranta
 * lists and what any hedge venue lists. New listings on either side appear
 * without a code change.
 *
 * Only the cases where two venues genuinely disagree on naming need an
 * override.
 */

import type { HedgeVenueId } from "@/lib/types";

export type AssetClass = "crypto" | "equity" | "commodity" | "metal" | "fx" | "other";

export interface ParsedSymbol {
  /** Canonical key, taken from the Veranta base since Veranta anchors every pair. */
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
 * "Commodities.CLLZ6/USD" -> { base: "CLLZ6",   klass: "commodity" }
 * "FX.EUR/USD"            -> { base: "EURUSD",  klass: "fx" }
 */
export function parseVerantaSymbol(symbol: string | undefined): ParsedSymbol | null {
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

// Standard futures month codes: F,G,H,J,K,M,N,Q,U,V,X,Z (Jan..Dec).
const FUTURES_EXPIRY = /^([A-Z]+)[FGHJKMNQUVXZ]\d$/;

/**
 * Root commodity for a dated-futures base, e.g. "WTIV6" / "CLLZ6" -> "WTI".
 * Returns null for bases that aren't a dated-futures contract.
 */
export function futuresRoot(base: string): string | null {
  const m = FUTURES_EXPIRY.exec(base);
  if (!m) return null;
  // Pyth switched its dated WTI crude feed from WTI* to CLL* (e.g. CLLZ6).
  return m[1] === "CLL" ? "WTI" : m[1];
}

/**
 * Veranta base -> hedge venue ticker, only where plain equality fails.
 * A `null` entry blocks a false ticker collision (same symbol, different asset).
 *
 * Hyperliquid: main-book crypto markets use bare symbols (`BTC`, `kBONK`,
 * `kPEPE`, `kSHIB`), whereas RWA / equity / metal / FX markets live on the
 * `xyz` HIP-3 dex (`XYZ:NVDA`, `XYZ:GOLD`, `XYZ:EUR`, etc.). Keeping the `XYZ:`
 * prefix in the map prevents equity tickers like `DASH` (DoorDash) and `STX`
 * (Seagate) from colliding with main-book crypto tokens (`DASH` = Dash, `STX` =
 * Stacks). Hyperliquid's `xyz:SP500` (~7600) and `xyz:XYZ100` (~28900) are the
 * indices rather than the SPY/QQQ ETFs (~760 / ~700), so `SPY` and `QQQ` are
 * blocked (`null`).
 *
 * Lighter: lists both the SPY/QQQ ETFs and the US500/US100 indices under their
 * own symbols, plus 1000x meme contracts (`1000BONK`, `1000PEPE`, `1000SHIB`,
 * `1000FLOKI`). `DASH` on Lighter is Dash (crypto), not DoorDash.
 *
 * Ostium: keys pairs as `${from}${to}` (e.g. `XAUUSD`, `NVDAUSD`, `EURUSD`).
 * Its `SPXUSD` and `NDXUSD` are the indices, not the SPY/QQQ ETFs.
 *
 * Variational: the 1000x contracts are a denomination difference, not an asset
 * difference. Funding is a percentage of notional, so it is invariant to the
 * contract multiplier and the match is exact for our purposes. SPY maps to
 * US500, which despite the index-sounding ticker is Variational's listing of
 * the SPDR S&P 500 ETF itself, marked around 760 like the ETF. Do not be
 * tempted by Variational's SPX: that is SPX6900, a memecoin. BB and STX
 * (BlackBerry and Seagate Technology) are X-suffixed (`BBX`, `STXX`); plain
 * `STX` on Variational is Stacks (crypto), and plain `DASH` on Variational is
 * Dash (crypto) whereas Veranta's `DASH` is DoorDash (`Equity.US.DASH/USD`).
 *
 * Ondo: quotes generic WTI and Brent rather than a dated contract, and carries
 * SPY and QQQ under their own tickers, so SPY needs no redirect the way it
 * does on Variational. Ondo's US500 is the index, not the ETF.
 *
 * Pacifica: kBONK/kPEPE/kSHIB are the same 1000x denomination as Variational.
 * SKHY is Veranta's truncated ticker for SK Hynix; Pacifica lists SKHYNIX.
 * Pacifica's SP500 is the index (~7600), not the SPY ETF — do not redirect.
 *
 * Binance / Bybit / OKX / Gate: CEX linear USDT perps. On Binance, Bybit and
 * Gate, plain `BB` is BounceBit (crypto, ~$0.0076), whereas Binance and Bybit
 * list BlackBerry as `BBX` and Seagate as `STXX` (plain `STX` is Stacks and
 * plain `DASH` is Dash on all four CEXs). OKX's `BB` is BlackBerry (~$8.89).
 *
 * Dated crude (CLLZ6, WTIV6, BRENTZ6, …) is matched by root in FUTURES_HEDGE
 * rather than listed expiry-by-expiry here — Veranta rolls the contract and the
 * hedge venues quote the generic.
 */
export const HEDGE_OVERRIDES: Record<HedgeVenueId, Record<string, string | null>> = {
  hyperliquid: {
    BONK: "kBONK",
    PEPE: "kPEPE",
    SHIB: "kSHIB",
    FLOKI: "kFLOKI",
    XAU: "XYZ:GOLD",
    XAG: "XYZ:SILVER",
    EURUSD: "XYZ:EUR",
    GBPUSD: "XYZ:GBP",
    USDJPY: "XYZ:JPY",
    USDKRW: "XYZ:KRW",
    GOOG: "XYZ:GOOGL",
    SPY: null,
    QQQ: null,
    DASH: null,
    STX: null,
  },
  lighter: {
    BONK: "1000BONK",
    PEPE: "1000PEPE",
    SHIB: "1000SHIB",
    FLOKI: "1000FLOKI",
    GOOG: "GOOGL",
    DASH: null,
    STX: null,
  },
  ostium: {
    SPY: null,
    QQQ: null,
    DASH: null,
    STX: null,
  },
  variational: {
    SPY: "US500",
    BONK: "1000BONK",
    PEPE: "1000PEPE",
    PUMP: "PUMPFUN",
    LIT: "LIGHTER",
    GOOG: "GOOGL",
    BB: "BBX",
    STX: "STXX",
    DASH: null,
  },
  ondo: {
    GOOG: "GOOGL",
  },
  grvt: {
    BONK: "KBONK",
    PEPE: "KPEPE",
    SHIB: "KSHIB",
    GOOG: "GOOGL",
    BB: "BBX",
    STX: "STXX",
  },
  pacifica: {
    GOOG: "GOOGL",
    BONK: "kBONK",
    PEPE: "kPEPE",
    SHIB: "kSHIB",
    SKHY: "SKHYNIX",
  },
  jupiter: {},
  antarctic: {
    XAU: "GOLD",
    XAG: "SILVER",
    GOOG: "GOOGL",
  },
  binance: {
    BONK: "1000BONK",
    PEPE: "1000PEPE",
    SHIB: "1000SHIB",
    FLOKI: "1000FLOKI",
    GOOG: "GOOGL",
    BB: "BBX",
    STX: "STXX",
    DASH: null,
  },
  bybit: {
    BONK: "1000BONK",
    PEPE: "1000PEPE",
    SHIB: "SHIB1000",
    FLOKI: "1000FLOKI",
    PUMP: "PUMPFUN",
    GOOG: "GOOGL",
    BB: "BBX",
    STX: "STXX",
    DASH: null,
  },
  okx: {
    GOOG: "GOOGL",
    STX: null,
    DASH: null,
  },
  gate: {
    GOOG: "GOOGL",
    BB: null,
    STX: null,
    DASH: null,
  },
};

/**
 * Dated Veranta futures root -> the hedge venue's generic ticker.
 * Pacifica has no Brent.
 */
const FUTURES_HEDGE: Record<HedgeVenueId, Record<string, string>> = {
  hyperliquid: { WTI: "XYZ:CL", BRENT: "XYZ:BRENTOIL" },
  lighter: { WTI: "WTI", BRENT: "BRENTOIL" },
  ostium: { WTI: "CLUSD", BRENT: "BRENTUSD" },
  variational: { WTI: "CL", BRENT: "BZ" },
  ondo: { WTI: "WTI", BRENT: "BRENT" },
  grvt: { WTI: "CL", BRENT: "BZ" },
  pacifica: { WTI: "CL" },
  jupiter: {},
  antarctic: { WTI: "CL" },
  binance: { WTI: "CL", BRENT: "BZ" },
  bybit: { WTI: "CL", BRENT: "BZ" },
  okx: { WTI: "CL", BRENT: "BZ" },
  gate: { WTI: "CL", BRENT: "BZ" },
};

/**
 * Matches that are close enough to hedge but not the identical instrument.
 * Surfaced in the UI rather than hidden. Dated-crude caveats are looked up
 * by futures root in matchCaveatFor so a roll does not drop the warning.
 */
export const MATCH_CAVEATS: Record<HedgeVenueId, Record<string, string>> = {
  hyperliquid: {
    GOOG: "Veranta lists Alphabet Class C, Hyperliquid lists Class A (GOOGL) — near but not identical",
  },
  lighter: {
    GOOG: "Veranta lists Alphabet Class C, Lighter lists Class A (GOOGL) — near but not identical",
  },
  ostium: {},
  variational: {
    GOOG: "Veranta lists Alphabet Class C, Variational lists Class A (GOOGL) — near but not identical",
  },
  ondo: {
    GOOG: "Veranta lists Alphabet Class C, Ondo lists Class A (GOOGL) — near but not identical",
  },
  grvt: {
    GOOG: "Veranta lists Alphabet Class C, GRVT lists Class A (GOOGL) — near but not identical",
  },
  pacifica: {
    GOOG: "Veranta lists Alphabet Class C, Pacifica lists Class A (GOOGL) — near but not identical",
  },
  jupiter: {},
  antarctic: {
    GOOG: "Veranta lists Alphabet Class C, Antarctic lists Class A (GOOGL) — near but not identical",
  },
  binance: {
    GOOG: "Veranta lists Alphabet Class C, Binance lists Class A (GOOGL) — near but not identical",
  },
  bybit: {
    GOOG: "Veranta lists Alphabet Class C, Bybit lists Class A (GOOGL) — near but not identical",
  },
  okx: {
    GOOG: "Veranta lists Alphabet Class C, OKX lists Class A (GOOGL) — near but not identical",
  },
  gate: {
    GOOG: "Veranta lists Alphabet Class C, Gate lists Class A (GOOGL) — near but not identical",
  },
};

const FUTURES_CAVEATS: Record<HedgeVenueId, Record<string, string>> = {
  hyperliquid: {
    WTI: "Veranta prices a specific WTI futures expiry, Hyperliquid quotes generic WTI (xyz:CL)",
    BRENT: "Veranta prices a specific Brent futures expiry, Hyperliquid quotes generic Brent (xyz:BRENTOIL)",
  },
  lighter: {
    WTI: "Veranta prices a specific WTI futures expiry, Lighter quotes generic WTI",
    BRENT: "Veranta prices a specific Brent futures expiry, Lighter quotes generic Brent (BRENTOIL)",
  },
  ostium: {
    WTI: "Veranta prices a specific WTI futures expiry, Ostium quotes generic WTI (CL/USD)",
    BRENT: "Veranta prices a specific Brent futures expiry, Ostium quotes generic Brent (BRENT/USD)",
  },
  variational: {
    WTI: "Veranta prices a specific WTI futures expiry, Variational quotes generic WTI",
    BRENT: "Veranta prices a specific Brent futures expiry, Variational quotes generic Brent",
  },
  ondo: {
    WTI: "Veranta prices a specific WTI futures expiry, Ondo quotes generic WTI",
    BRENT: "Veranta prices a specific Brent futures expiry, Ondo quotes generic Brent",
  },
  grvt: {
    WTI: "Veranta prices a specific WTI futures expiry, GRVT quotes generic WTI (CL)",
    BRENT: "Veranta prices a specific Brent futures expiry, GRVT quotes generic Brent (BZ)",
  },
  pacifica: {
    WTI: "Veranta prices a specific WTI futures expiry, Pacifica quotes generic WTI (CL)",
  },
  jupiter: {},
  antarctic: {
    WTI: "Veranta prices a specific WTI futures expiry, Antarctic quotes generic WTI (CL_USDT)",
  },
  binance: {
    WTI: "Veranta prices a specific WTI futures expiry, Binance quotes generic WTI (CLUSDT)",
    BRENT: "Veranta prices a specific Brent futures expiry, Binance quotes generic Brent (BZUSDT)",
  },
  bybit: {
    WTI: "Veranta prices a specific WTI futures expiry, Bybit quotes generic WTI (CLUSDT)",
    BRENT: "Veranta prices a specific Brent futures expiry, Bybit quotes generic Brent (BZUSDT)",
  },
  okx: {
    WTI: "Veranta prices a specific WTI futures expiry, OKX quotes generic WTI (CL-USDT-SWAP)",
    BRENT: "Veranta prices a specific Brent futures expiry, OKX quotes generic Brent (BZ-USDT-SWAP)",
  },
  gate: {
    WTI: "Veranta prices a specific WTI futures expiry, Gate quotes generic WTI (CL_USDT)",
    BRENT: "Veranta prices a specific Brent futures expiry, Gate quotes generic Brent (BZ_USDT)",
  },
};

export function hedgeTickerFor(
  venue: HedgeVenueId,
  verantaBase: string,
  klass?: AssetClass,
): string {
  const overrides = HEDGE_OVERRIDES[venue];
  if (verantaBase in overrides) {
    const exact = overrides[verantaBase];
    return exact ? exact.toUpperCase() : "";
  }
  const root = futuresRoot(verantaBase);
  if (root) {
    const mapped = FUTURES_HEDGE[venue][root];
    return mapped ? mapped.toUpperCase() : "";
  }
  const upper = verantaBase.toUpperCase();
  if (venue === "hyperliquid" && klass && klass !== "crypto") {
    return `XYZ:${upper}`;
  }
  if (venue === "ostium") {
    return klass === "fx" ? upper : `${upper}USD`;
  }
  return upper;
}

export function matchCaveatFor(
  venue: HedgeVenueId,
  verantaBase: string,
): string | undefined {
  const exact = MATCH_CAVEATS[venue][verantaBase];
  if (exact) return exact;
  const root = futuresRoot(verantaBase);
  return root ? FUTURES_CAVEATS[venue][root] : undefined;
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

/**
 * Direct deep-link to a venue's trading UI for a given Veranta base asset.
 *
 * Uses the venue-specific mapped ticker (via `hedgeTickerFor`) so 1000x
 * contracts (`kPEPE`, `1000PEPE`, `SHIB1000`), HIP-3 RWA feeds (`xyz:NVDA`,
 * `xyz:CL`), and dated-futures roots resolve to the exact market page.
 */
export function venueTradeUrl(
  venue: HedgeVenueId | "veranta",
  verantaBase: string,
  klass?: AssetClass,
  side?: "long" | "short",
): string {
  const base = verantaBase.toUpperCase();
  if (venue === "veranta") {
    return klass === "fx" && base.length === 6
      ? `https://www.veranta.xyz/trade?asset=${base.slice(0, 3)}-${base.slice(3)}`
      : `https://www.veranta.xyz/trade?asset=${base}-USD`;
  }

  const raw = hedgeTickerFor(venue, base, klass) || base;

  switch (venue) {
    case "hyperliquid": {
      const sym = raw.startsWith("XYZ:") ? `xyz:${raw.slice(4)}` : raw;
      return `https://app.hyperliquid.xyz/trade/${sym}`;
    }
    case "lighter":
      return `https://app.lighter.xyz/trade/${raw}`;
    case "ostium": {
      if (klass === "fx" && base.length === 6) {
        return `https://app.ostium.com/trade?from=${base.slice(0, 3)}&to=${base.slice(3)}`;
      }
      const from = raw.endsWith("USD") ? raw.slice(0, -3) : raw;
      return `https://app.ostium.com/trade?from=${from}&to=USD`;
    }
    case "variational":
      return `https://omni.variational.io/perpetual/${raw}`;
    case "ondo":
      return `https://app.ondoperps.xyz/?market=${raw}-USD.P`;
    case "grvt":
      return `https://grvt.io/exchange/perpetual/${raw}-USDT`;
    case "pacifica":
      return `https://app.pacifica.fi/trade/${raw}`;
    case "jupiter": {
      const dir = side ?? "long";
      return `https://jup.ag/perps/${dir}/${base}-${base}`;
    }
    case "antarctic":
      return `https://www.antarctic.exchange/trade/perpetual/${raw.toLowerCase()}_usdt`;
    case "binance":
      return `https://www.binance.com/en/futures/${raw}USDT`;
    case "bybit":
      return `https://www.bybit.com/trade/usdt/${raw}USDT`;
    case "okx":
      return `https://www.okx.com/trade-swap/${raw.toLowerCase()}-usdt-swap`;
    case "gate":
      return `https://www.gate.io/futures/USDT/${raw}_USDT`;
  }
}
