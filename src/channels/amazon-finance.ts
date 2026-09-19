import type { CanonicalReturn } from "./types";

/**
 * Pure parsers for Amazon money data — no network, no database — so the rules
 * that decide what a rupee means can be tested against a saved payload.
 */

/* -------------------------------------------------------------------------- */
/* Finances API v2024-06-19                                                   */
/* -------------------------------------------------------------------------- */

interface RawBreakdown {
  breakdownType: string;
  breakdownAmount: { currencyAmount: number };
  breakdowns?: RawBreakdown[];
}

export interface RawTransaction {
  transactionId: string;
  transactionType: string;
  transactionStatus: string;
  description?: string;
  postedDate: string;
  totalAmount: { currencyAmount: number };
  relatedIdentifiers?: { relatedIdentifierName: string; relatedIdentifierValue: string }[];
  items?: { breakdowns?: RawBreakdown[] }[];
}

export interface FinanceLine {
  transactionId: string;
  type: string;
  status: string;
  description: string | null;
  postedAt: Date;
  externalOrderId: string | null;
  groupId: string | null;
  deferredId: string | null;
  total: number;
  principal: number;
  tax: number;
  promo: number;
  tcsTds: number;
  fees: number;
  postage: number;
  refundCommission: number;
}

const POSTAGE_FEES = new Set(["MFNPostageFee", "MFNDeliveryServiceFee"]);

function related(t: RawTransaction, name: string): string | null {
  return t.relatedIdentifiers?.find((r) => r.relatedIdentifierName === name)?.relatedIdentifierValue ?? null;
}

/**
 * Sort one transaction's breakdown tree into the buckets the Finance screen
 * reports on. Amazon's top-level breakdown already sums its children, so this
 * reads the top level and only descends into `AmazonFees`, where postage and
 * the refund clawback have to be told apart from ordinary fees.
 */
export function toFinanceLine(t: RawTransaction): FinanceLine {
  const line: FinanceLine = {
    transactionId: t.transactionId,
    type: t.transactionType,
    status: t.transactionStatus,
    description: t.description ?? null,
    postedAt: new Date(t.postedDate),
    externalOrderId: related(t, "ORDER_ID"),
    groupId: related(t, "FINANCIAL_EVENT_GROUP_ID"),
    deferredId: related(t, "DEFERRED_TRANSACTION_ID"),
    total: t.totalAmount.currencyAmount,
    principal: 0,
    tax: 0,
    promo: 0,
    tcsTds: 0,
    fees: 0,
    postage: 0,
    refundCommission: 0,
  };

  const top = (t.items ?? []).flatMap((i) => i.breakdowns ?? []);
  for (const b of top) {
    const amt = b.breakdownAmount.currencyAmount;
    switch (b.breakdownType) {
      case "ProductCharges":
        line.principal += amt;
        break;
      case "Tax":
        line.tax += amt;
        break;
      case "PromoRebates":
        line.promo += amt;
        break;
      case "TaxCollectedAtSource":
      case "TaxWithholding":
        line.tcsTds += amt;
        break;
      case "AmazonFees":
        for (const c of b.breakdowns ?? []) {
          const a = c.breakdownAmount.currencyAmount;
          if (POSTAGE_FEES.has(c.breakdownType)) line.postage += a;
          else if (c.breakdownType === "RefundCommission") line.refundCommission += a;
          else line.fees += a;
        }
        break;
      case "FBAFees":
        line.fees += amt;
        break;
      default:
        break; // Shipping charges and anything new stay in the remainder.
    }
  }

  // Lines with no breakdown tree: Easy Ship gives postage back this way.
  if (top.length === 0) {
    if (t.description === "EasyshipFulfillmentFeeRefund") line.postage += line.total;
    else if (t.description === "FulfillmentFeeRefund") line.fees += line.total;
  }

  return line;
}

/* -------------------------------------------------------------------------- */
/* Returns report (GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE)                 */
/* -------------------------------------------------------------------------- */

function num(v: string | undefined): number | null {
  const n = Number((v ?? "").trim());
  return v && v.trim() !== "" && Number.isFinite(n) ? n : null;
}

function reportDate(v: string | undefined): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const d = new Date(`${s} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Amazon's reason codes are terse ("AMZ-PG-APP-TOO-SMALL"); say what they mean. */
export function reasonLabel(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  if (!c) return "Unknown";
  const known: Record<string, string> = {
    POOR_FIT: "Poor fit",
    "AMZ-PG-APP-TOO-SMALL": "Too small",
    "AMZ-PG-APP-TOO-LARGE": "Too large",
    "AMZ-PG-APP-STYLE": "Didn't like the style",
    DID_NOT_LIKE_COLOR: "Colour not as expected",
    NOT_AS_PHOTO: "Not as in photo",
    "CR-SWITCHEROO": "Wrong item sent",
    "CR-DEFECTIVE": "Defective",
    "CR-QUALITY_UNACCEPTABLE": "Quality unacceptable",
    "CR-UNWANTED_ITEM": "Unwanted item",
    "CR-MISSING_PARTS": "Missing parts",
    "UND-UNKNOWN": "Undelivered (unknown)",
  };
  return known[c] ?? c.replace(/^(CR|AMZ-PG-APP|UND)-/, "").replace(/[_-]+/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());
}

export function parseReturnsReport(tsv: string): CanonicalReturn[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split("\t").map((h) => h.trim());
  const out: CanonicalReturn[] = [];

  for (const l of lines.slice(1)) {
    const cells = l.split("\t");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));

    const rma = row["Amazon RMA ID"];
    const orderId = row["Order ID"];
    if (!rma || !orderId) continue;

    const type = row["Return type"];
    out.push({
      externalReturnId: `${rma}:${row["Order Item ID"] || row["Merchant SKU"]}`,
      externalOrderId: orderId,
      // "Undelivered" / "Rejected" are parcels that never reached the customer;
      // they come back as RTO. Everything else is a customer return.
      kind: type === "Undelivered" || type === "Rejected" ? "rto" : "return",
      reason: reasonLabel(row["Return Reason"]),
      awb: row["Tracking ID"] || null,
      status: row["Return request status"] || null,
      requestedAt: reportDate(row["Return request date"]),
      refundAmount: num(row["Refunded Amount"]),
      labelCost: num(row["Label cost"]),
      resolution: row["Resolution"] || null,
      raw: row,
    });
  }
  return out;
}
