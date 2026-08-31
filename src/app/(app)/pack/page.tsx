import { redirect } from "next/navigation";

import { FEATURES } from "@/config/features";
import { requireUser } from "@/lib/auth";

import { packStats } from "./actions";
import { PackStation } from "./pack-station";

export const dynamic = "force-dynamic";

export default async function PackPage() {
  await requireUser();
  if (!FEATURES.packStation) redirect("/orders");

  const stats = await packStats();

  return (
    <div className="mx-auto max-w-2xl">
      <PackStation initial={stats} />
    </div>
  );
}
