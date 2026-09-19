import type { FileItem, Phase, RunFileReport, RunResult } from "../printer-view";

export const DEMO_STATES = [
  { id: "empty", label: "Empty" },
  { id: "files", label: "Files added" },
  { id: "processing", label: "Building" },
  { id: "done", label: "Ready" },
  { id: "warnings", label: "Ready + warnings" },
  { id: "toolarge", label: "Too large" },
  { id: "error", label: "No labels found" },
] as const;

export type DemoState = (typeof DEMO_STATES)[number]["id"];

const MB = 1024 * 1024;

const FILES: FileItem[] = [
  { id: "1", name: "a_091126.pdf", size: 1.6 * MB },
  { id: "2", name: "m_091126.pdf", size: 0.7 * MB },
  { id: "3", name: "flipkart labels (2).pdf", size: 0.4 * MB },
];

const REPORTS: RunFileReport[] = [
  { name: "a_091126.pdf", pages: 24, labels: 12, skipped: Array.from({ length: 12 }, (_, i) => ({ pageIndex: i * 2 + 1, kind: "invoice", reason: "invoice" })) },
  { name: "m_091126.pdf", pages: 9, labels: 9, skipped: [] },
  { name: "flipkart labels (2).pdf", pages: 4, labels: 0, skipped: Array.from({ length: 4 }, (_, i) => ({ pageIndex: i, kind: "unrecognised", reason: "no detector" })) },
];

const RESULT: RunResult = {
  id: 42,
  url: "#",
  labels: 21,
  sheets: 6,
  files: REPORTS,
  duplicates: [],
  framesRemoved: 0,
  unstamped: 0,
};

export function demoProps(state: DemoState): {
  files: FileItem[];
  phase: Phase;
  result?: RunResult;
  error?: { message: string; files?: RunFileReport[] };
} {
  switch (state) {
    case "empty":
      return { files: [], phase: "idle" };
    case "files":
      return { files: FILES, phase: "idle" };
    case "processing":
      return { files: FILES, phase: "processing" };
    case "done":
      return { files: FILES.slice(0, 2), phase: "done", result: { ...RESULT, files: REPORTS.slice(0, 2) } };
    case "warnings":
      return {
        files: FILES,
        phase: "done",
        result: {
          ...RESULT,
          duplicates: ["405-3218864-9915520", "171-0021479-3382713"],
          framesRemoved: 5,
          unstamped: 3,
        },
      };
    case "toolarge":
      return { files: [...FILES, { id: "4", name: "amazon big batch.pdf", size: 3.9 * MB }], phase: "idle" };
    case "error":
      return {
        files: [FILES[2]],
        phase: "error",
        error: {
          message: "None of these pages look like shipping labels. Check that you uploaded the label PDFs.",
          files: [REPORTS[2]],
        },
      };
  }
}
