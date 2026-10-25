import { Tip, TipHead } from "@/components/Tooltip";
import { listHedgeNames } from "@/lib/rank";
import {
  HEDGE_VENUES,
  type Blocked,
  type BlockedReason,
  type HedgeVenueId,
} from "@/lib/types";

function reasonLabel(
  reason: BlockedReason,
  hedges: readonly HedgeVenueId[],
): string {
  const scoped = hedges.length < HEDGE_VENUES.length;
  const names = listHedgeNames(hedges);
  switch (reason) {
    case "no_edge":
      return scoped
        ? `No edge against ${names}`
        : "No edge after the Veranta rate";
    case "anchor_closed":
      return "Veranta market closed";
    case "hedge_closed":
      return scoped ? `${names} market closed` : "Every hedge market closed";
    case "not_listed_hedge":
      return scoped ? `Not listed on ${names}` : "Not listed on any hedge venue";
  }
}

const ORDER: BlockedReason[] = [
  "no_edge",
  "anchor_closed",
  "hedge_closed",
  "not_listed_hedge",
];

/** Withheld assets, grouped by why. Each asset carries its detail on hover. */
export function WithheldPanel({
  blocked,
  hedges = HEDGE_VENUES,
}: {
  blocked: Blocked[];
  hedges?: readonly HedgeVenueId[];
}) {
  const groups = ORDER.map((reason) => ({
    reason,
    items: blocked.filter((b) => b.reason === reason),
  }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);

  const biggest = Math.max(...groups.map((g) => g.items.length), 1);

  return (
    <div className="withheld">
      {groups.map(({ reason, items }) => (
        <details className="wh-row" key={reason}>
          <summary>
            <span className="caret" aria-hidden>
              ▸
            </span>
            <span className="wh-reason">{reasonLabel(reason, hedges)}</span>
            <span className="wh-share" aria-hidden>
              <i style={{ width: `${((items.length / biggest) * 100).toFixed(3)}%` }} />
            </span>
            <span className="wh-count">{items.length}</span>
          </summary>
          <div className="wh-assets">
            {items.map((b) => (
              <Tip
                className="a"
                key={b.asset}
                content={
                  <>
                    <TipHead label={b.label} />
                    <span className="tip-why">{b.detail}</span>
                  </>
                }
              >
                {b.asset}
              </Tip>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
