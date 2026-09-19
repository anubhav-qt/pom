export type Platform = "amazon" | "meesho" | "flipkart" | "unknown";

/**
 * What a page is for, decided from its content only. Never from its position or
 * its file name: Amazon happens to alternate label / invoice, Meesho puts both
 * on one page, and the next platform will do something else again.
 */
export type PageKind = "label" | "invoice" | "unrecognised";

/** One product line as printed on the invoice: what the packer needs to see at a glance. */
export interface ProductLine {
  name: string;
  size: string;
  color: string;
}

export interface PageInfo {
  /** 0-based page number inside its source file. */
  index: number;
  kind: PageKind;
  platform: Platform;
  /** Digits of the marketplace order id when it could be read, for de-duping and the log. */
  orderId: string | null;
  /** Product lines read from this page (invoice pages, and Meesho's combined page). */
  products: ProductLine[];
  /** One line on why the page was classified this way, kept for the run log. */
  reason: string;
}

export interface SourceFile {
  /** Whatever the user called it. Only ever displayed, never parsed. */
  name: string;
  data: Uint8Array;
}

export interface LabelRef {
  fileIndex: number;
  pageIndex: number;
  platform: Platform;
  orderId: string | null;
  /** Empty when the invoice could not be read; the label is then printed unstamped. */
  products: ProductLine[];
}

export interface FileReport {
  name: string;
  pages: number;
  labels: number;
  skipped: { pageIndex: number; kind: PageKind; reason: string }[];
  error?: string;
}

export interface PrintRunResult {
  pdf: Uint8Array;
  /** Label pages placed on the sheets, in output order. */
  labels: LabelRef[];
  sheets: number;
  files: FileReport[];
  /** Order ids that showed up on more than one label page. */
  duplicates: string[];
  /** Labels whose black frame was erased. */
  framesRemoved: number;
  /** Labels printed without a product stamp because no product could be read. */
  unstamped: number;
}
