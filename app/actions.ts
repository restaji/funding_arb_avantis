"use server";

import { revalidatePath, updateTag } from "next/cache";

import { invalidateFetchCache } from "@/lib/net";
import { invalidateScanCache } from "@/lib/strategy";

/**
 * updateTag rather than revalidateTag: inside a server action it gives
 * read-your-own-writes, so the re-render that follows sees the new rates
 * instead of the ones we just expired.
 */
export async function refreshFunding() {
  invalidateFetchCache();
  invalidateScanCache();
  updateTag("funding");
  revalidatePath("/");
}
