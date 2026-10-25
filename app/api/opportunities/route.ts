import { NextResponse } from "next/server";

import { scan } from "@/lib/strategy";

export const revalidate = 60;
export const maxDuration = 30;
export const preferredRegion = ["fra1", "hnd1"];

/** Ranked Veranta-anchored carry pairs, best per asset. */
export async function GET() {
  const result = await scan();
  return NextResponse.json(result);
}
