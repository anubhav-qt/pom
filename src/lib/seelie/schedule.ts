/**
 * When a routine runs: a few presets in India time (no daylight saving, so a fixed +5:30).
 * Types and plain functions only, so the screen can describe and check a schedule too.
 */

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export type HourStep = (typeof HOUR_STEPS)[number];

export type RoutineSchedule =
  /** Every few hours: the slots fall on `time` and every `hours` from it, round the clock. */
  | { every: "hours"; hours: HourStep; time: string }
  | { every: "day"; time: string }
  /** days: 0 Sunday … 6 Saturday. */
  | { every: "week"; days: number[]; time: string }
  /** day 1–31; a month without that day runs on its last day. */
  | { every: "month"; day: number; time: string };

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "09:30" → 570, or null. */
export function minutesOf(time: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A schedule as given (by the screen or the model), checked; throws with what's wrong. */
export function checkSchedule(raw: unknown): RoutineSchedule {
  const s = (raw ?? {}) as Record<string, unknown>;
  const time = typeof s.time === "string" ? s.time.trim() : "";
  const mins = minutesOf(time);
  if (mins === null) throw new Error("Give the time as HH:MM, 24-hour, India time (e.g. 09:00).");
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  switch (s.every) {
    case "hours": {
      const hours = Number(s.hours);
      if (!HOUR_STEPS.includes(hours as HourStep)) throw new Error(`Every ${HOUR_STEPS.join(", ")} hours.`);
      return { every: "hours", hours: hours as HourStep, time: hhmm };
    }
    case "day":
      return { every: "day", time: hhmm };
    case "week": {
      const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!days.length) throw new Error("Pick at least one day of the week.");
      return days.length === 7 ? { every: "day", time: hhmm } : { every: "week", days, time: hhmm };
    }
    case "month": {
      const day = Number(s.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("The day of the month is 1 to 31.");
      return { every: "month", day, time: hhmm };
    }
    default:
      throw new Error('every is "hours", "day", "week" or "month".');
  }
}

/** The first time the schedule falls on strictly after `after`. */
export function nextRun(s: RoutineSchedule, after: Date): Date {
  const wall = after.getTime() + IST_MS;
  const dayStart = Math.floor(wall / DAY_MS) * DAY_MS;
  const at = (minutesOf(s.time) ?? 0) * 60_000;
  let next: number;

  switch (s.every) {
    case "hours": {
      // The steps divide 24 hours, so every day has the same slots.
      const step = s.hours * 3_600_000;
      const first = at % step;
      next = dayStart + first + Math.max(0, Math.floor((wall - dayStart - first) / step) + 1) * step;
      break;
    }
    case "day":
      next = dayStart + at;
      if (next <= wall) next += DAY_MS;
      break;
    case "week": {
      next = NaN;
      for (let i = 0; i <= 7; i++) {
        const t = dayStart + i * DAY_MS + at;
        if (t > wall && s.days.includes(new Date(t).getUTCDay())) {
          next = t;
          break;
        }
      }
      break;
    }
    case "month": {
      const d = new Date(dayStart);
      next = NaN;
      for (let i = 0; i <= 12; i++) {
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + i;
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const t = Date.UTC(y, m, Math.min(s.day, last)) + at;
        if (t > wall) {
          next = t;
          break;
        }
      }
      break;
    }
  }
  return new Date(next - IST_MS);
}

/** "9:00 am" from "09:00". */
export function timeLabel(time: string) {
  const mins = minutesOf(time) ?? 0;
  const h = Math.floor(mins / 60);
  return `${h % 12 || 12}:${String(mins % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function ordinal(n: number) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

function dayList(days: number[]) {
  const key = days.join("");
  if (key === "12345") return "Weekdays";
  if (key === "06") return "Weekends";
  if (days.length === 1) return `${WEEKDAY_NAMES[days[0]]}s`;
  const names = days.map((d) => WEEKDAYS[d]);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The schedule in words: "Mon, Wed and Fri at 9:00 am". */
export function describeSchedule(s: RoutineSchedule) {
  const at = timeLabel(s.time);
  switch (s.every) {
    case "hours":
      return s.hours === 1 ? `Every hour from ${at}` : `Every ${s.hours} hours from ${at}`;
    case "day":
      return `Every day at ${at}`;
    case "week":
      return `${dayList(s.days)} at ${at}`;
    case "month":
      return s.day >= 29 ? `Monthly on the ${ordinal(s.day)} (or the month's last day) at ${at}` : `Monthly on the ${ordinal(s.day)} at ${at}`;
  }
}

/** "Mon 6 Oct, 9:00 am" in India time. */
export function whenLabel(at: Date | string) {
  return new Date(at).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
