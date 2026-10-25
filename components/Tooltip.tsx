"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Long enough that sweeping across a dense row does not strobe. */
const SHOW_DELAY_MS = 60;
/** Clearance from the anchor, and from the viewport edge. */
const GAP = 9;
const EDGE = 8;

/**
 * Positions itself after measuring, so it can flip above or below the anchor
 * and stay inside the viewport. Hidden on the first pass to avoid a jump.
 */
function Bubble({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const fitsAbove = anchor.top - height - GAP >= EDGE;

    setPos({
      left: Math.max(
        EDGE,
        Math.min(anchor.left + anchor.width / 2 - width / 2, vw - width - EDGE),
      ),
      top: fitsAbove
        ? anchor.top - height - GAP
        : Math.min(anchor.bottom + GAP, vh - height - EDGE),
    });
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="tip"
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      {typeof children === "string" ? <p className="tip-text">{children}</p> : children}
    </div>
  );
}

interface TipProps {
  content: ReactNode;
  children?: ReactNode;
  /** Defaults to a span; pass the cell tag when decorating a table. */
  as?: "span" | "div" | "td" | "th";
  className?: string;
  onClick?: () => void;
  colSpan?: number;
  "aria-sort"?: "ascending" | "descending" | "none" | "other";
}

/**
 * Replaces the native `title` attribute: no one-second delay, no OS styling,
 * and the content can be laid out rather than crammed into one string.
 */
export function Tip({ content, children, as, ...rest }: TipProps) {
  // Polymorphic on a small set of tags; the cast keeps the call sites plain.
  const Tag = (as ?? "span") as ElementType;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const close = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  };

  const open = (el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setAnchor(el.getBoundingClientRect()),
      SHOW_DELAY_MS,
    );
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A tooltip pinned to a stale rect is worse than none, so any scroll or
  // resize dismisses it outright.
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => setAnchor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);

  if (content == null) {
    return <Tag {...rest}>{children}</Tag>;
  }

  return (
    <Tag
      {...rest}
      onMouseEnter={(e: React.MouseEvent<HTMLElement>) => open(e.currentTarget)}
      onMouseLeave={close}
      onFocus={(e: React.FocusEvent<HTMLElement>) => open(e.currentTarget)}
      onBlur={close}
    >
      {children}
      {anchor && createPortal(<Bubble anchor={anchor}>{content}</Bubble>, document.body)}
    </Tag>
  );
}

/** Heading row, for tooltips that need a label above their body. */
export function TipHead({ label }: { label: ReactNode }) {
  return <div className="tip-head">{label}</div>;
}

