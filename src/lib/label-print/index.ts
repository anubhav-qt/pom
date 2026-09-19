import { classifyPages } from "./classify";
import { composeFourUp, type ComposeOptions } from "./compose";
import { extractImageBoxes, extractPageLayouts, extractPageTexts } from "./extract";
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

  if (options?.stamp !== false) await measureStampAreas(files, labels);
  await measureLayouts(files, labels, options?.stamp !== false);

  const seen = new Map<string, number>();
  for (const l of labels) if (l.orderId) seen.set(l.orderId, (seen.get(l.orderId) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);

  const { pdf, sheets, framesRemoved } = await composeFourUp(files, labels, options);
  // Flipkart labels are deliberately left plain, so they are not "missing" a stamp.
  const unstamped = labels.filter((l) => l.products.length === 0 && l.platform !== "flipkart").length;
  return { pdf, labels, sheets, files: reports, duplicates, framesRemoved, unstamped };
}

/**
 * Meesho and Flipkart pages: measure what is really on each page. Meesho's
 * stamp goes in the blank space just under its box; Flipkart's label box is
 * cropped out of the page it shares with the invoice.
 */
async function measureLayouts(files: SourceFile[], labels: LabelRef[], stamp: boolean) {
  const byFile = new Map<number, LabelRef[]>();
  for (const l of labels) {
    const wanted = l.platform === "flipkart" || (stamp && l.platform === "meesho" && l.products.length > 0);
    if (wanted) byFile.set(l.fileIndex, [...(byFile.get(l.fileIndex) ?? []), l]);
  }

  for (const [fileIndex, refs] of byFile) {
    try {
      const layouts = await extractPageLayouts(files[fileIndex].data, refs.map((r) => r.pageIndex));
      for (const ref of refs) {
        const layout = layouts.get(ref.pageIndex);
        if (!layout) continue;
        if (ref.platform === "flipkart") {
          const f = layout.frame;
          if (f) {
            // A hair of margin so the frame's own line is not clipped.
            const pad = 0.004;
            ref.crop = { x: Math.max(0, f.left - pad), y: Math.max(0, f.top - pad), w: f.width + pad * 2, h: f.height + pad * 2 };
          }
        } else if (layout.ink) {
          // Just under the last line of the Meesho box, down to near the page foot.
          const { left, right, bottom } = layout.ink;
          const y = bottom + 0.008;
          const h = Math.min(0.11, 0.97 - y);
          if (h > 0.03) ref.stampArea = { x: left, y, w: right - left, h };
        }
      }
    } catch {
      // Keep the defaults for this file.
    }
  }
}

/**
 * Amazon lays its label out a little differently from carrier to carrier and
 * places the picture differently on the page, so the stamp goes wherever this
 * label's own blank band is. Anything that cannot be measured keeps the
 * platform's default position.
 */
async function measureStampAreas(files: SourceFile[], labels: LabelRef[]) {
  const byFile = new Map<number, LabelRef[]>();
  for (const l of labels) {
    if (l.platform === "amazon" && l.products.length > 0) byFile.set(l.fileIndex, [...(byFile.get(l.fileIndex) ?? []), l]);
  }

  for (const [fileIndex, refs] of byFile) {
    try {
      const data = files[fileIndex].data;
      const boxes = await extractImageBoxes(data, refs.map((r) => r.pageIndex));
      for (const ref of refs) {
        const box = boxes.get(ref.pageIndex);
        const gap = box?.gap;
        if (!box || !gap) continue;
        const top = box.top + gap.top * box.height;
        const bottom = box.top + gap.bottom * box.height;
        ref.stampArea = { x: box.left + box.width * 0.03, y: top, w: box.width * 0.93, h: bottom - top };
      }
    } catch {
      // Keep the defaults for this file.
    }
  }
}
