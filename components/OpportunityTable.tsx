"use client";

import { useMemo, useState } from "react";

import { Tip } from "@/components/Tooltip";
import { Venue, venueTone } from "@/components/Venue";
import { bps, earnClass, pct, usd } from "@/lib/format";
import { CLASS_LABEL, CLASS_ORDER, venueTradeUrl, type AssetClass } from "@/lib/symbols";
import {
  HEDGE_VENUES,
  legsOf,
  VENUE_LABEL,
  type HedgeVenueId,
  type Opportunity,
} from "@/lib/types";

type SortKey =
  | "rank"
  | "asset"
  | "trade"
  | "av"
  | "hedge"
  | "bar"
  | "net"
  | "apr"
  | "vol"
  | "hvol"
  | "oi";

interface Row {
  o: Opportunity;
  rank: number;
  avBps: number;
  hedgeBps: number;
}

const VALUE: Record<SortKey, (r: Row) => number | string> = {
  rank: (r) => r.rank,
  asset: (r) => r.o.asset,
  // Which venue is on the far side and which way round Veranta sits, so the
  // rows that are the same trade group together.
  trade: (r) => `${r.o.hedgeVenue} ${r.o.anchorSide}`,
  av: (r) => r.avBps,
  hedge: (r) => r.hedgeBps,
  // The bar draws the net, so sorting it sorts by what the bar shows.
  bar: (r) => r.o.netCarryBps,
  net: (r) => r.o.netCarryBps,
  apr: (r) => r.o.carryAprPct,
  vol: (r) => r.o.volume24hUsd,
  hvol: (r) => r.o.hedgeVolume24hUsd,
  oi: (r) => {
    const t = r.o.verantaLongOiUsd + r.o.verantaShortOiUsd;
    return t > 0 ? r.o.verantaLongOiUsd / t : 0.5;
  },
};

/** Ascending is the sensible default for names and rank, descending for money. */
const ASC_FIRST = new Set<SortKey>(["rank", "asset", "trade"]);

/**
 * Geometry for one row's cost-vs-earn bar.
 *
 * Rates are signed so positive means the trader pays; restating each leg as
 * what it earns puts costs left of the axis and income right of it. The tick
 * marks the net, so a row pays exactly when the tick sits right of centre.
 *
 * Anything past the scale is drawn hard against the edge and flagged, rather
 * than allowed to set the scale for everyone else.
 */
function balance(avBps: number, hedgeBps: number, hedgeTone: string, scale: number) {
  const segs: Array<{ tone: string; left: number; width: number }> = [];
  let left = 50;
  let right = 50;
  let over: "left" | "right" | null = null;

  for (const [tone, earn] of [
    ["av", -avBps],
    [hedgeTone, -hedgeBps],
  ] as const) {
    const width = (Math.abs(earn) / scale) * 50;
    if (width <= 0) continue;

    let from: number;
    let to: number;
    if (earn >= 0) {
      from = right;
      to = right + width;
      right = to;
    } else {
      to = left;
      from = left - width;
      left = from;
    }
    if (to > 100) over = "right";
    if (from < 0) over = "left";

    const a = Math.max(0, Math.min(100, from));
    const b = Math.max(0, Math.min(100, to));
    if (b > a) segs.push({ tone, left: Number(a.toFixed(3)), width: Number((b - a).toFixed(3)) });
  }

  const net = -(avBps + hedgeBps);
  const raw = 50 + (net / scale) * 50;
  if (raw > 100) over = "right";
  if (raw < 0) over = "left";

  return { segs, tick: Number(Math.min(100, Math.max(0, raw)).toFixed(3)), over };
}

/**
 * Bar scale, clamped to the 90th percentile of row magnitude.
 *
 * A single four-figure rate would otherwise flatten every other bar to a
 * sliver, and the point of the column is comparing the typical row.
 */
function barScale(mags: number[]): number {
  if (mags.length === 0) return 1;
  const sorted = [...mags].sort((a, b) => a - b);
  return Math.max(sorted[Math.floor((sorted.length - 1) * 0.9)], 1e-6);
}

/** Venue volume spans zero to nine figures, so the meter is log-scaled. */
const VOL_FLOOR_USD = 1_000;

function volMeter(v: number, max: number): number {
  if (v <= 0) return 0;
  const floor = Math.log10(VOL_FLOOR_USD);
  const span = Math.log10(max) - floor;
  if (span <= 0) return 1;
  return Math.max(0.03, (Math.log10(v) - floor) / span);
}

function oiSplit(longUsd: number, shortUsd: number): { longPct: number; shortPct: number } {
  const t = longUsd + shortUsd;
  if (t <= 0) return { longPct: 0, shortPct: 0 };
  const longPct = Number(((longUsd / t) * 100).toFixed(3));
  return { longPct, shortPct: Number((100 - longPct).toFixed(3)) };
}

function Header({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <Tip
      as="th"
      content={title}
      className={`sortable ${className}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : "·"}</span>
    </Tip>
  );
}

export function OpportunityTable({ rows }: { rows: Opportunity[] }) {
  // Every row here already pays, so the open question is how much size it can
  // take, not whether to take it. Depth leads; the other columns still sort.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "vol",
    dir: "desc",
  });
  const [klass, setKlass] = useState<AssetClass | "all">("all");

  const all = useMemo<Row[]>(
    () =>
      rows.map((o, i) => {
        const { anchor, hedge } = legsOf(o);
        return {
          o,
          rank: i + 1,
          avBps: anchor.dailyPct * 100,
          hedgeBps: hedge.dailyPct * 100,
        };
      }),
    [rows],
  );

  const classCounts = useMemo(() => {
    const counts = new Map<AssetClass, number>();
    for (const r of all) counts.set(r.o.klass, (counts.get(r.o.klass) ?? 0) + 1);
    return CLASS_ORDER.filter((k) => counts.has(k)).map(
      (k) => [k, counts.get(k) as number] as const,
    );
  }, [all]);

  const venueCounts = useMemo(() => {
    const counts = new Map<HedgeVenueId, number>();
    for (const r of all) {
      counts.set(r.o.hedgeVenue, (counts.get(r.o.hedgeVenue) ?? 0) + 1);
    }
    return HEDGE_VENUES.filter((v) => counts.has(v)).map(
      (v) => [v, counts.get(v) as number] as const,
    );
  }, [all]);

  const visible = useMemo(() => {
    const kept = all.filter((r) => klass === "all" || r.o.klass === klass);
    const value = VALUE[sort.key];
    const flip = sort.dir === "asc" ? 1 : -1;
    return [...kept].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (typeof x === "string" || typeof y === "string") {
        return String(x).localeCompare(String(y)) * flip;
      }
      return (x - y) * flip;
    });
  }, [all, klass, sort]);

  const scale = useMemo(
    () =>
      barScale(
        visible.map((r) =>
          Math.max(Math.abs(r.avBps), Math.abs(r.hedgeBps), Math.abs(r.o.netCarryBps)),
        ),
      ),
    [visible],
  );

  // One scale across both volume columns, so the two meters can be read
  // against each other to see which leg is the binding constraint.
  const maxVol = useMemo(
    () =>
      visible.reduce(
        (m, r) => Math.max(m, r.o.volume24hUsd, r.o.hedgeVolume24hUsd),
        VOL_FLOOR_USD * 10,
      ),
    [visible],
  );

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: ASC_FIRST.has(key) ? "asc" : "desc" },
    );

  const head = { sort, onSort };

  return (
    <>
      <div className="controls">
        <span className="ctl-label">Class</span>
        <div className="chips">
          <button
            className="chip-btn"
            aria-pressed={klass === "all"}
            onClick={() => setKlass("all")}
          >
            All<span className="count">{all.length}</span>
          </button>
          {classCounts.map(([k, n]) => (
            <button
              key={k}
              className="chip-btn"
              aria-pressed={klass === k}
              onClick={() => setKlass(k)}
            >
              {CLASS_LABEL[k]}
              <span className="count">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nothing matches this filter — try clearing it.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <Header
                  label="#"
                  sortKey="rank"
                  className="num"
                  title="Position under the sort in force. Click any header to re-sort."
                  {...head}
                />
                <Header
                  label="Asset"
                  sortKey="asset"
                  title="The market, as Veranta names it, matched to the hedge venue by symbol."
                  {...head}
                />
                <Header
                  label="The trade"
                  sortKey="trade"
                  title="Which way round Veranta sits, and which venue takes the far side."
                  {...head}
                />
                <Header
                  label="Veranta leg (24h)"
                  sortKey="av"
                  className="num av"
                  title="Veranta's 24h rate, funding plus borrow, in bps of notional. Positive means you pay."
                  {...head}
                />
                <Header
                  label="Hedge leg (24h)"
                  sortKey="hedge"
                  className="num hedge"
                  title="The hedge venue's 24h funding, in bps of notional. Positive means you pay."
                  {...head}
                />
                <Header
                  label="Cost vs earn"
                  sortKey="bar"
                  title="Cost left of the axis, income right of it. The tick is the net."
                  {...head}
                />
                <Header
                  label="Net carry (24h)"
                  sortKey="net"
                  className="num key"
                  title="Both legs summed and negated, in bps of notional per day. Positive means the position pays you."
                  {...head}
                />
                <Header
                  label="Net APR"
                  sortKey="apr"
                  className="num key"
                  title="Net carry annualized flat. A snapshot rate, not a backtest."
                  {...head}
                />
                <Header
                  label="Veranta 24h vol"
                  sortKey="vol"
                  className="num"
                  title="Notional traded on Veranta over the last day."
                  {...head}
                />
                <Header
                  label="Hedge 24h vol"
                  sortKey="hvol"
                  className="num"
                  title="Notional traded on the venue taking the far side. The thinner leg caps the pair."
                  {...head}
                />
                <Header
                  label="Veranta L / S"
                  sortKey="oi"
                  className="num"
                  title="Veranta long against short open interest. Sorted on the long share."
                  {...head}
                />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const { o, avBps, hedgeBps } = r;
                const hedgeTone = venueTone(o.hedgeVenue);
                const { segs, tick, over } = balance(avBps, hedgeBps, hedgeTone, scale);
                const hedgeSide = o.anchorSide === "long" ? "short" : "long";
                const split = oiSplit(o.verantaLongOiUsd, o.verantaShortOiUsd);
                return (
                  <tr key={o.asset}>
                    <td className="rank">{r.rank}</td>
                    <td className="asset">
                      {o.asset}
                      <span className="sub">
                        {o.label}
                        <span className="klass bare">{CLASS_LABEL[o.klass]}</span>
                        {o.caveat && (
                          <Tip className="approx" content={o.caveat}>
                            approx
                          </Tip>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="direction">
                        <a
                          className={`leg-btn ${o.anchorSide}`}
                          href={venueTradeUrl("veranta", o.asset, o.klass, o.anchorSide)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span className={`s ${o.anchorSide}`}>{o.anchorSide}</span>
                          <Venue venue="veranta" />
                        </a>
                        <a
                          className={`leg-btn ${hedgeSide}`}
                          href={venueTradeUrl(o.hedgeVenue, o.asset, o.klass, hedgeSide)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span className={`s ${hedgeSide}`}>{hedgeSide}</span>
                          <Venue venue={o.hedgeVenue} />
                        </a>
                      </span>
                    </td>
                    <td className="num av-num">
                      <span>{bps(avBps, 2)}</span>
                      <span className="leg-sub">{pct(avBps / 100, 3)}/24h</span>
                    </td>
                    <td className={`num ${hedgeTone}-num`}>
                      <span>{bps(hedgeBps, 2)}</span>
                      <span className="leg-sub">{pct(hedgeBps / 100, 3)}/24h</span>
                    </td>
                    <td className="balance">
                      <div className="bar">
                        {over && (
                          <span className={`over ${over}`} aria-hidden>
                            {over === "right" ? "›" : "‹"}
                          </span>
                        )}
                        <span className="axis" aria-hidden />
                        {segs.map((s, idx) => (
                          <span
                            key={s.tone ?? idx}
                            className={`seg ${s.tone}`}
                            style={{ left: `${s.left}%`, width: `${s.width}%` }}
                          />
                        ))}
                        <span className="tick" style={{ left: `${tick}%` }} aria-hidden />
                      </div>
                    </td>
                    <td className={`num ${earnClass(o.netCarryBps)}`}>
                      <strong>{bps(o.netCarryBps, 2)}</strong>
                      <span className="leg-sub">{pct(o.netCarryBps / 100, 3)}/24h</span>
                    </td>
                    <td className={`num ${earnClass(o.carryAprPct)}`}>
                      <strong>{pct(o.carryAprPct, 1)}</strong>
                    </td>
                    <td className="num">
                      <span className="dim">{usd(o.volume24hUsd)}</span>
                      <span className="meter" aria-hidden>
                        <i style={{ width: `${(volMeter(o.volume24hUsd, maxVol) * 100).toFixed(3)}%` }} />
                      </span>
                    </td>
                    <td className="num">
                      <span className="dim">{usd(o.hedgeVolume24hUsd)}</span>
                      <span className="meter" aria-hidden>
                        <i
                          style={{
                            width: `${(volMeter(o.hedgeVolume24hUsd, maxVol) * 100).toFixed(3)}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td className="num">
                      <span className="dim ls">
                        <span className="l">{usd(o.verantaLongOiUsd)}</span>
                        <span className="sep">/</span>
                        <span className="sh">{usd(o.verantaShortOiUsd)}</span>
                      </span>
                      <span className="meter skew" aria-hidden>
                        <i className="long" style={{ flex: `${split.longPct} 0 0` }} />
                        <i className="short" style={{ flex: `${split.shortPct} 0 0` }} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="bar-key">
        <span>
          <i className="av" aria-hidden /> Veranta rate
        </span>
        {venueCounts.map(([v]) => (
          <span key={v}>
            <i className={venueTone(v)} aria-hidden /> {VENUE_LABEL[v]} funding
          </span>
        ))}
        <span>
          <i className="net" aria-hidden /> Net
        </span>
      </div>
    </>
  );
}
