import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const CONTRACTS_API = "https://api.gateio.ws/api/v4/futures/usdt/contracts";
const TICKERS_API = "https://api.gateio.ws/api/v4/futures/usdt/tickers";

interface GateContract {
  name?: string;
  funding_rate?: string | number;
  funding_rate_indicative?: string | number;
  funding_interval?: number;
  in_delisting?: boolean;
}

interface GateTicker {
  contract?: string;
  volume_24h_settle?: string | number;
  volume_24h_quote?: string | number;
  total_size?: string | number;
  mark_price?: string | number;
  quanto_multiplier?: string | number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const SECONDS_PER_DAY = 86_400;

/**
 * Every Gate.io USDT-margined perpetual (`*_USDT`), keyed by base symbol.
 *
 * `funding_rate` on `/api/v4/futures/usdt/contracts` is a decimal fraction per
 * `funding_interval` seconds (e.g. `0.0001` for 0.01% per 28,800s = 8h).
 * 24h USD volume (`volume_24h_settle`) and open interest come from `/tickers`.
 */
export async function fetchGateMarkets(): Promise<Map<string, HedgeMarket>> {
  const [contracts, tickers] = await Promise.all([
    fetchJson<GateContract[]>(CONTRACTS_API),
    fetchJson<GateTicker[]>(TICKERS_API).catch(() => [] as GateTicker[]),
  ]);

  const tickerByContract = new Map<string, GateTicker>();
  for (const t of tickers ?? []) {
    if (t?.contract) tickerByContract.set(t.contract.toUpperCase(), t);
  }

  const out = new Map<string, HedgeMarket>();

  for (const c of contracts ?? []) {
    if (!c?.name || c.in_delisting) continue;
    const contract = String(c.name).toUpperCase();
    if (!contract.endsWith("_USDT")) continue;

    const base = contract.slice(0, -"_USDT".length);
    if (!base) continue;

    const intervalS = c.funding_interval && c.funding_interval > 0 ? c.funding_interval : 28_800;
    const rateFrac = num(c.funding_rate ?? c.funding_rate_indicative);
    const longDailyPct = rateFrac * (SECONDS_PER_DAY / intervalS) * 100;

    const t = tickerByContract.get(contract);
    const volume24hUsd = num(t?.volume_24h_settle ?? t?.volume_24h_quote);
    const openInterestUsd =
      num(t?.total_size) * num(t?.quanto_multiplier) * num(t?.mark_price);

    out.set(base, {
      venue: "gate",
      asset: base,
      market: contract,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalS,
      stale: rateFrac === 0,
      volume24hUsd,
      openInterestUsd,
    });
  }

  return out;
}
