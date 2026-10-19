/**
 * What the owner may change on an approval card before saying yes: a post's caption and
 * whether a reel shows on the grid, an ad's budget and length, which looks a photoshoot
 * makes. Applied to the call's own arguments (the card and the engine use the same
 * rules), and put into words for the model, which is told that what ran isn't quite what
 * it asked for. Pure: the card imports it too.
 */
import type { ApprovalEdits } from "./types";

type Args = Record<string, unknown>;

const record = (v: unknown): Args => (v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {});
const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10_000_000;
const isDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 30;
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 12) : []);

/** Which tools' cards can be changed, and what on them. */
export function editableOf(tool: string, args: unknown): (keyof ApprovalEdits)[] {
  const a = record(args);
  switch (tool) {
    case "instagram_post":
      return a.type === "story" ? [] : a.type === "reel" ? ["caption", "shareToFeed"] : ["caption"];
    case "ads_create":
      return ["budget", "days"];
    case "ads_manage":
      return a.action === "raise_budget" ? ["budget"] : [];
    case "photoshoot":
      return a.action === "shoot" ? ["lookIds"] : [];
    default:
      return [];
  }
}

/** The call's arguments with the owner's changes; anything the card can't change is left as it was. */
export function applyEdits(tool: string, args: unknown, edits: ApprovalEdits): unknown {
  const can = editableOf(tool, args);
  const out: Args = { ...record(args) };
  if (can.includes("caption") && typeof edits.caption === "string") out.caption = edits.caption.trim().slice(0, 2200);
  if (can.includes("shareToFeed") && typeof edits.shareToFeed === "boolean") out.shareToFeed = edits.shareToFeed;
  if (can.includes("budget") && isMoney(edits.budget)) out.budget = Math.round(edits.budget);
  if (can.includes("days") && isDays(edits.days)) {
    out.days = edits.days;
    delete out.end;
  }
  if (can.includes("lookIds")) {
    const looks = ids(edits.lookIds);
    if (looks.length) out.lookIds = looks;
  }
  return out;
}

/** What differs between the arguments asked for and the ones approved, as edits (null: nothing). */
export function editsBetween(tool: string, before: unknown, after: unknown): ApprovalEdits | null {
  const a = record(before);
  const b = record(after);
  const can = editableOf(tool, a);
  const edits: ApprovalEdits = {};
  if (can.includes("caption") && typeof b.caption === "string" && b.caption !== (a.caption ?? "")) edits.caption = b.caption;
  if (can.includes("shareToFeed") && typeof b.shareToFeed === "boolean" && b.shareToFeed !== (a.shareToFeed ?? true)) edits.shareToFeed = b.shareToFeed;
  if (can.includes("budget") && isMoney(b.budget) && b.budget !== a.budget) edits.budget = b.budget;
  if (can.includes("days") && isDays(b.days) && (b.days !== a.days || a.end !== undefined)) edits.days = b.days;
  if (can.includes("lookIds")) {
    const was = ids(a.lookIds);
    const now = ids(b.lookIds);
    if (now.length && now.join() !== was.join()) edits.lookIds = now;
  }
  return Object.keys(edits).length ? edits : null;
}

const quote = (s: string) => `"${s.length > 140 ? `${s.slice(0, 140)}…` : s}"`;

/** The changes in words, for the line the model reads above the result. */
export function describeEdits(tool: string, edits: ApprovalEdits, asked: unknown): string[] {
  const a = record(asked);
  const can = editableOf(tool, a);
  const out: string[] = [];
  if (can.includes("caption") && edits.caption !== undefined && edits.caption.trim() !== String(a.caption ?? "").trim()) {
    out.push(edits.caption.trim() ? `the caption is now ${quote(edits.caption.trim())}` : "no caption");
  }
  if (can.includes("shareToFeed") && edits.shareToFeed !== undefined && edits.shareToFeed !== (a.shareToFeed ?? true)) {
    out.push(edits.shareToFeed ? "shared to the main grid too" : "kept off the main grid (Reels tab only)");
  }
  if (can.includes("budget") && isMoney(edits.budget) && Math.round(edits.budget) !== a.budget) {
    out.push(`budget ${Math.round(edits.budget)} instead of ${String(a.budget ?? "?")}`);
  }
  if (can.includes("days") && isDays(edits.days) && (edits.days !== a.days || a.end !== undefined)) {
    out.push(`${edits.days} day${edits.days === 1 ? "" : "s"} instead of ${a.days !== undefined ? `${String(a.days)} days` : a.end ? `until ${String(a.end)}` : "what was asked"}`);
  }
  if (can.includes("lookIds") && edits.lookIds?.length) {
    const was = ids(a.lookIds);
    const dropped = was.filter((id) => !edits.lookIds!.includes(id));
    out.push(`only these looks: ${edits.lookIds.join(", ")}${dropped.length ? ` (not ${dropped.join(", ")})` : ""}`);
  }
  return out;
}
