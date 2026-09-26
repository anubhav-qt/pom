import { requireUser } from "@/lib/auth";

import { Reels } from "./reels";

export const dynamic = "force-dynamic";

export default async function ReelsPage() {
  await requireUser();
  return <Reels />;
}
