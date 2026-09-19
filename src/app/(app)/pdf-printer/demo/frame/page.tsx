import { requireUser } from "@/lib/auth";

import { DemoFrameClient } from "../frame-client";
import { DEMO_STATES, type DemoState } from "../fixtures";

export const dynamic = "force-dynamic";

/** One demo state of the printer screen, sized by whatever iframe holds it. */
export default async function DemoFramePage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await requireUser();
  const { state } = await searchParams;
  const id = (DEMO_STATES.find((s) => s.id === state)?.id ?? "empty") as DemoState;

  return <DemoFrameClient initial={id} />;
}
