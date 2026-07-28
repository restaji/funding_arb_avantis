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
 * The socket-api feed carries funding and open interest but no volume, so this
 * is a second call. Pairs that did not trade are omitted from the payload
 * rather than reported as zero, so a missing key means no flow.
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
