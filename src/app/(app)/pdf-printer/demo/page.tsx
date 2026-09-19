import { requireUser } from "@/lib/auth";

import { DemoStage } from "./demo-stage";

export const dynamic = "force-dynamic";

export default async function PdfPrinterDemoPage() {
  await requireUser();
  return <DemoStage />;
}
