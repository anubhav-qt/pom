"use server";

import { requireUser } from "@/lib/auth";

import { editRestockItems, fillRestockItems, rebuildRestockPlan, restockPlan, type RestockPlan } from "./planner";

export type { PlanCell, PlanProduct, RestockPlan } from "./planner";

/** The restock planner's server calls from the screen (the work itself is in planner.ts). */

export async function getRestockPlan(): Promise<RestockPlan> {
  await requireUser();
  return restockPlan();
}

export async function resetRestockPlan(): Promise<RestockPlan> {
  await requireUser();
  return rebuildRestockPlan();
}

/* Edits — deliberately fire-and-forget from the client */

export async function updateRestockItems(ids: number[], patch: { have?: number; buyOverride?: number | null; excluded?: boolean }) {
  await requireUser();
  return editRestockItems(ids, patch);
}

/** Bulk "we have enough of these": set have = needed, clear any override/exclusion. */
export async function markRestockInStock(ids: number[]) {
  await requireUser();
  return fillRestockItems(ids);
}
