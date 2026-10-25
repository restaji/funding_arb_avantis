import { Tip, TipHead } from "@/components/Tooltip";
import { type Blocked, type BlockedReason } from "@/lib/types";

const REASON_LABEL: Record<BlockedReason, string> = {
  no_edge: "No edge after the Veranta rate",
  anchor_closed: "Veranta market closed",
  hedge_closed: "Every hedge market closed",
  not_listed_hedge: "Not listed on any hedge venue",
};

const ORDER: BlockedReason[] = [
  "no_edge",
  "anchor_closed",
  "hedge_closed",
  "not_listed_hedge",
];

/** Withheld assets, grouped by why. Each asset carries its detail on hover. */
export function WithheldPanel({ blocked }: { blocked: Blocked[] }) {
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
            <span className="wh-reason">{REASON_LABEL[reason]}</span>
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
