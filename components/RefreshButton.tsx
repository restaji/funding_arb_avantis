"use client";

import { useTransition } from "react";

import { refreshFunding } from "@/app/actions";

export function RefreshButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="btn"
      disabled={pending}
      onClick={() => startTransition(() => refreshFunding())}
    >
      {pending ? "Fetching…" : "Refresh rates"}
    </button>
  );
}
