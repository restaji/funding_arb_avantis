import { NextResponse } from "next/server";

import { scan } from "@/lib/strategy";

export const revalidate = 120;
export const maxDuration = 30;

/** Ranked Avantis-anchored carry pairs, best per asset. */
export async function GET() {
  const result = await scan();
  return NextResponse.json(result);
}
