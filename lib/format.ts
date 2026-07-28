const signed = (n: number, digits: number): string =>
  `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

/** Basis points per day, signed. */
export const bps = (n: number, digits = 2): string => signed(n, digits);

/** Percent, signed, with the unit attached. */
export const pct = (n: number, digits = 2): string => `${signed(n, digits)}%`;

/** Daily percent rate at the precision these venues actually quote. */
export const ratePct = (n: number): string => `${signed(n, 6)}%`;

/** Compact USD, e.g. $180.8M. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

/** Unsigned percent, for shares and utilisation rather than rates. */
export const share = (frac: number, digits = 0): string =>
  `${(frac * 100).toFixed(digits)}%`;

/** Class name for a value where positive means the trader pays. */
export const payClass = (n: number): string =>
  n > 0 ? "pay" : n < 0 ? "earn" : "zero";

/** Class name for a value where positive means the trader earns. */
export const earnClass = (n: number): string =>
  n > 0 ? "earn" : n < 0 ? "pay" : "zero";

export function utcStamp(iso: string): string {
  return `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
