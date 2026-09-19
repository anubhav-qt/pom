import { classifyPages } from "./classify";
import { composeFourUp, type ComposeOptions } from "./compose";
import { extractPageTexts } from "./extract";
import type { FileReport, LabelRef, PrintRunResult, SourceFile } from "./types";

export * from "./types";

export class NoLabelsError extends Error {
  constructor(public files: FileReport[]) {
    super("No label pages were found in the uploaded PDFs.");
  }
}

/**
 * Turn any mix of marketplace PDFs into one four-up label sheet.
 *
 * Files are processed in the order given and their labels keep that order, so
 * the sheet reads the way the user stacked the uploads. Nothing here looks at
 * file names; every page is judged on its own content. A file that cannot be
 * read is reported and skipped instead of failing the whole run.
 */
export async function buildLabelSheets(
  files: SourceFile[],
  options?: ComposeOptions,
): Promise<PrintRunResult> {
  const labels: LabelRef[] = [];
  const reports: FileReport[] = [];

  for (const [fileIndex, file] of files.entries()) {
    const report: FileReport = { name: file.name, pages: 0, labels: 0, skipped: [] };
    reports.push(report);
    try {
      const pages = classifyPages(await extractPageTexts(file.data));
      report.pages = pages.length;
      for (const p of pages) {
        if (p.kind === "label") {
          labels.push({ fileIndex, pageIndex: p.index, platform: p.platform, orderId: p.orderId, products: p.products });
          report.labels++;
        } else {
          report.skipped.push({ pageIndex: p.index, kind: p.kind, reason: p.reason });
        }
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : "Could not read this PDF";
    }
  }

  if (labels.length === 0) throw new NoLabelsError(reports);

  const seen = new Map<string, number>();
  for (const l of labels) if (l.orderId) seen.set(l.orderId, (seen.get(l.orderId) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);

  const { pdf, sheets, framesRemoved } = await composeFourUp(files, labels, options);
  const unstamped = labels.filter((l) => l.products.length === 0).length;
  return { pdf, labels, sheets, files: reports, duplicates, framesRemoved, unstamped };
}
