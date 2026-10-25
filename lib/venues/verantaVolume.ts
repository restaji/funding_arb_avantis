import { fetchJson } from "@/lib/net";

const VOLUME_API =
  "https://api.veranta.xyz/v1/history/analytics/daily-volumes-by-pair/1/true";

interface VerantaVolumePayload {
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
 * Veranta traded notional over the last day, keyed by pair index.
 *
 * Same endpoint the Veranta trade UI calls for "24h Volume"
 * (`/history/analytics/daily-volumes-by-pair/1/true`). data.veranta.xyz/v2/trading
 * has no 24h volume field. Pairs that did not trade are omitted rather than
 * reported as zero, so a missing key means no flow. Only the standard pair's
 * own index is read (`_UPSIDE` pair indices are ignored).
 */
export async function fetchVerantaVolumes(): Promise<Map<number, number>> {
  const payload = await fetchJson<VerantaVolumePayload>(VOLUME_API);
  const out = new Map<number, number>();

  for (const row of payload.cumulativeVolumes ?? []) {
    const idx = Number(row?.pairIndex);
    if (!Number.isInteger(idx)) continue;
    out.set(idx, num(row.cumulativeVolume));
  }

  return out;
}
