import "server-only";

import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Telling whether another OMS process is still running. On the ThinkPad the OMS is up to
 * eight processes in one container (infra/cluster.cjs), sharing a hostname and pids; a
 * run or a render records which one holds it as host:pid:start, the start being when the
 * process began (Linux /proc, in ticks since boot), so a pid reused after a restart isn't
 * taken for the old process.
 */

/** A process's state and start from /proc/<pid>/stat, or null where there's no /proc. */
function procStat(pid: number): { state: string; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (name) state ppid ..."; the name may hold spaces and brackets.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], start: fields[19] };
  } catch {
    return null;
  }
}

/** This process: host:pid, plus :start where /proc tells it. */
export const PROCESS_TAG = (() => {
  const start = procStat(process.pid)?.start;
  return `${os.hostname()}:${process.pid}${start ? `:${start}` : ""}`;
})();

/** A process on this machine (by pid) is running and is the one that started at `start` when given. */
export function pidAlive(pid: number, start?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: there, but not ours to signal.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const stat = procStat(pid);
  if (!stat) return true;
  // A zombie has ended; nobody collected it yet.
  if (stat.state === "Z" || stat.state === "X") return false;
  return !start || stat.start === start;
}

/**
 * Whether the process a tag names is still running: true or false when it was on this
 * machine, null when this process can't tell (another machine, or no tag).
 */
export function processAlive(tag: string | null | undefined): boolean | null {
  if (!tag) return null;
  const [host, pid, start] = tag.split(":");
  if (host !== os.hostname()) return null;
  return pidAlive(Number(pid), start);
}

/** The program a pid runs ("ffmpeg"), where /proc tells it. */
export function processName(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}
