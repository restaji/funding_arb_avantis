const VOLUME_API =
  "https://api.avantisfi.com/v1/history/analytics/daily-volumes-by-pair/1/true";

interface AvantisVolumePayload {
  cumulativeVolumes?: Array<{
    pairIndex?: number | string;
    cumulativeVolume?: number | string;
  }>;
  success?: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Avantis traded notional over the last day, keyed by pair index.
 *
 * Same endpoint the Avantis trade UI calls for "24h Volume"
 * (`/history/analytics/daily-volumes-by-pair/1/true`). data.avantisfi.com/v2/trading
 * has no 24h volume field. Pairs that did not trade are omitted rather than
 * reported as zero, so a missing key means no flow. `_UPSIDE` siblings are
 * folded into the underlying pair by the caller.
 */
export async function fetchAvantisVolumes(): Promise<Map<number, number>> {
  const res = await fetch(VOLUME_API, {
    next: { revalidate: 120, tags: ["funding"] },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Avantis daily-volumes-by-pair ${res.status}`);

  const payload = (await res.json()) as AvantisVolumePayload;
  const out = new Map<number, number>();

  for (const row of payload.cumulativeVolumes ?? []) {
    const idx = Number(row?.pairIndex);
    if (!Number.isInteger(idx)) continue;
    out.set(idx, num(row.cumulativeVolume));
  }

  return out;
}
