"use client";

import { useEffect, useRef, useTransition } from "react";

import { refreshFunding } from "@/app/actions";

const AUTO_REFRESH_MS = 60_000;

export function RefreshButton() {
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const lastRunRef = useRef(Date.now());

  const run = () => {
    if (pendingRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    lastRunRef.current = Date.now();
    startTransition(() => refreshFunding());
  };

  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastRunRef.current >= AUTO_REFRESH_MS) run();
    }, AUTO_REFRESH_MS);

    const onVisible = () => {
      if (!document.hidden && Date.now() - lastRunRef.current >= AUTO_REFRESH_MS) {
        run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <button
      className="btn"
      disabled={pending}
      onClick={run}
    >
      {pending ? "Fetching…" : "Refresh rates"}
    </button>
  );
}
