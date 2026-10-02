import { requireUser } from "@/lib/auth";

import { Seelie } from "./seelie";

export const dynamic = "force-dynamic";

export default async function SeeliePage() {
  await requireUser();
  return <Seelie />;
}
