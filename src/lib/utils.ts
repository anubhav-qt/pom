import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function money(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  return INR.format(Number(value));
}

/** IST-relative day label, since that is how the warehouse thinks about orders. */
export function dayLabel(date: Date | null | undefined) {
  if (!date) return "—";
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function timeLeft(deadline: Date | null | undefined) {
  if (!deadline) return null;
  const ms = deadline.getTime() - Date.now();
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  if (ms < 0) return { late: true, text: hours < 24 ? `${hours}h late` : `${Math.floor(hours / 24)}d late` };
  if (hours < 24) return { late: false, text: `${hours}h left` };
  return { late: false, text: `${Math.floor(hours / 24)}d left` };
}
