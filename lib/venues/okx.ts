import { fetchJson } from "@/lib/net";
import type { HedgeMarket } from "@/lib/types";

const FUNDING_API = "https://www.okx.com/api/v5/public/funding-rate?instId=ANY";
const TICKERS_API = "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
const OI_API = "https://www.okx.com/api/v5/public/open-interest?instType=SWAP";

interface OkxFundingItem {
  instId?: string;
  fundingRate?: string | number;
  fundingTime?: string | number;
  nextFundingTime?: string | number;
}

interface OkxTickerItem {
  instId?: string;
  last?: string | number;
  volCcy24h?: string | number;
}

interface OkxOiItem {
  instId?: string;
  oiUsd?: string | number;
}

interface OkxResponse<T> {
  data?: T[];
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const HOURS_PER_DAY = 24;

/**
 * Every OKX USDT-margined perpetual swap (`*-USDT-SWAP`), keyed by base symbol.
 *
 * `/api/v5/public/funding-rate?instId=ANY` returns all swaps in a single call.
 * `fundingRate` is a decimal fraction for the settlement at `fundingTime`, and
 * the interval is `(nextFundingTime - fundingTime)` in ms.
 *
 * Volume comes from `/api/v5/market/tickers?instType=SWAP` where `volCcy24h`
 * is 24h base-currency volume (`volCcy24h * last` = USD notional).
 */
export async function fetchOkxMarkets(): Promise<Map<string, HedgeMarket>> {
  const [fundingRes, tickersRes, oiRes] = await Promise.all([
    fetchJson<OkxResponse<OkxFundingItem>>(FUNDING_API),
    fetchJson<OkxResponse<OkxTickerItem>>(TICKERS_API).catch(
      () => ({ data: [] }) as OkxResponse<OkxTickerItem>,
    ),
    fetchJson<OkxResponse<OkxOiItem>>(OI_API).catch(
      () => ({ data: [] }) as OkxResponse<OkxOiItem>,
    ),
  ]);

  const volUsdByInst = new Map<string, number>();
  for (const t of tickersRes.data ?? []) {
    if (!t?.instId) continue;
    volUsdByInst.set(t.instId.toUpperCase(), num(t.volCcy24h) * num(t.last));
  }

  const oiUsdByInst = new Map<string, number>();
  for (const o of oiRes.data ?? []) {
    if (!o?.instId) continue;
    oiUsdByInst.set(o.instId.toUpperCase(), num(o.oiUsd));
  }

  const out = new Map<string, HedgeMarket>();

  for (const f of fundingRes.data ?? []) {
    if (!f?.instId) continue;
    const instId = String(f.instId).toUpperCase();
    if (!instId.endsWith("-USDT-SWAP")) continue;

    const base = instId.slice(0, -"-USDT-SWAP".length);
    if (!base) continue;

    const t0 = num(f.fundingTime);
    const t1 = num(f.nextFundingTime);
    const diffHours = t1 > t0 ? Math.round((t1 - t0) / 3_600_000) : 8;
    const intervalHours = diffHours > 0 ? diffHours : 8;

    const rateFrac = num(f.fundingRate);
    const longDailyPct = rateFrac * (HOURS_PER_DAY / intervalHours) * 100;

    out.set(base, {
      venue: "okx",
      asset: base,
      market: instId,
      name: base,
      longDailyPct,
      shortDailyPct: -longDailyPct,
      fundingIntervalS: intervalHours * 3600,
      stale: rateFrac === 0,
      volume24hUsd: volUsdByInst.get(instId) ?? 0,
      openInterestUsd: oiUsdByInst.get(instId) ?? 0,
    });
  }

  return out;
}
