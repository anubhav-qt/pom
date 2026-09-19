import { requireUser } from "@/lib/auth";

import { PdfPrinter } from "./pdf-printer";

export const dynamic = "force-dynamic";

export default async function PdfPrinterPage() {
  await requireUser();
  return <PdfPrinter />;
}
