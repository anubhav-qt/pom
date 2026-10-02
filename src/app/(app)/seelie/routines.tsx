"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { Modal } from "@/components/modal";
import { Segmented } from "@/components/segmented";
import { Toggle } from "@/components/toggle";
import { CenteredSpinner, Empty, Spinner } from "@/components/ui";
import type { RoutineView } from "@/lib/seelie/routines";
import { checkSchedule, describeSchedule, HOUR_STEPS, nextRun, whenLabel, type HourStep, type RoutineSchedule } from "@/lib/seelie/schedule";
import { useSeelie } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { deleteRoutineAction, routineEnabledAction, routinesAction, runRoutineAction, saveRoutineAction } from "./actions";
import { ModelPicker, ThinkingPicker } from "./composer";
import { Notice } from "./timeline";

/**
 * Routines: messages Seelie gets on a schedule, each run replying in the routine's own
 * chat. One modal lists them (switch, run now, edit, delete); the other makes or edits one.
 */

const STATUS_WORDS: Record<string, string> = {
  running: "running now",
  waiting: "waiting for your approval",
  done: "done",
  error: "failed",
  aborted: "stopped",
  interrupted: "cut off by a restart",
};

export function RoutinesModal({ onClose }: { onClose: () => void }) {
  const online = useSeelie((s) => s.status?.online ?? true);
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null: closed; "new": a new one; else the one being edited.
  const [editing, setEditing] = useState<RoutineView | "new" | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await routinesAction();
    if (res.ok) setRoutines(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: number, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(id);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) setError(res.error);
    await load();
    return res.ok;
  }

  async function runNow(r: RoutineView) {
    setBusy(r.id);
    setError(null);
    const res = await runRoutineAction(r.id);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    // Watch it reply.
    onClose();
    void useSeelie.getState().openChat(res.data.chatId);
    void useSeelie.getState().loadChats();
  }

  function onMenu(r: RoutineView, id: string) {
    if (id === "run") void runNow(r);
    else if (id === "open" && r.chatId) {
      onClose();
      void useSeelie.getState().openChat(r.chatId);
    } else if (id === "edit") setEditing(r);
    else if (id === "delete") setDeleting(r.id);
  }

  return (
    <>
      <Modal title="Routines" onClose={onClose} width="40rem">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <p className="muted text-xs">
              Seelie runs these on their schedule (India time) and replies in each one&apos;s chat. You can also ask for one in a chat: &ldquo;every Monday at 9, send me the ads
              report&rdquo;.
            </p>
            <button type="button" className="btn btn-primary shrink-0" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" />
              New routine
            </button>
          </div>

          {!online ? <Notice tone="warn">Seelie is offline on this server; routines run only while the ThinkPad serves the OMS.</Notice> : null}
          {error ? (
            <Notice tone="danger" onClose={() => setError(null)}>
              {error}
            </Notice>
          ) : null}

          {routines === null ? (
            <CenteredSpinner className="py-10" />
          ) : routines.length === 0 ? (
            <Empty title="No routines yet" hint="Make one for anything Seelie should do regularly: a weekly ads report, a morning stock check, a monthly returns summary." />
          ) : (
            <ul className="space-y-2">
              {routines.map((r) => {
                const menu: DropdownOption[] = [
                  { id: "run", label: "Run now" },
                  ...(r.chatId ? [{ id: "open", label: "Open its chat" }] : []),
                  { id: "edit", label: "Edit" },
                  { id: "delete", label: "Delete", dividerBefore: true },
                ];
                return (
                  <li key={r.id} className="rounded-xl border px-3.5 py-3" style={{ borderColor: "var(--border)" }}>
                    <div className="flex items-start gap-3">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(r)}>
                        <span className="block truncate text-sm font-medium">{r.name}</span>
                        <span className="muted block text-xs">{r.when}</span>
                        <span className="muted mt-1 block text-xs tabular-nums" style={{ color: "var(--muted-2)" }}>
                          {r.enabled && r.nextRunAt ? `Next ${whenLabel(r.nextRunAt)}` : "Off"}
                          {r.lastRunAt ? ` · last ${whenLabel(r.lastRunAt)}${r.lastStatus ? `, ${STATUS_WORDS[r.lastStatus] ?? r.lastStatus}` : ""}` : " · hasn't run yet"}
                        </span>
                      </button>
                      {busy === r.id ? <Spinner size="1.1rem" /> : null}
                      <Toggle
                        checked={r.enabled}
                        disabled={busy === r.id}
                        onChange={(on) => void act(r.id, () => routineEnabledAction(r.id, on))}
                        label={r.enabled ? "On" : "Off"}
                        className="shrink-0"
                      />
                      <DropdownMenu
                        align="right"
                        trigger={
                          <span className="nav-icon-btn h-7 w-7" aria-label={`${r.name} options`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </span>
                        }
                        options={menu}
                        activeId=""
                        onSelect={(id) => onMenu(r, id)}
                      />
                    </div>
                    {r.lastNote ? (
                      <div className="mt-2">
                        <Notice tone="warn">{r.lastNote}</Notice>
                      </div>
                    ) : null}
                    {deleting === r.id ? (
                      <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
                        <span className="muted mr-auto">Delete &ldquo;{r.name}&rdquo;? Its chat stays.</span>
                        <button type="button" className="btn" onClick={() => setDeleting(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ color: "var(--danger)", fontWeight: 600 }}
                          onClick={() => void act(r.id, () => deleteRoutineAction(r.id)).then(() => setDeleting(null))}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>

      {editing ? (
        <RoutineModal
          routine={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* One routine                                                                */
/* -------------------------------------------------------------------------- */

type Every = RoutineSchedule["every"];

const EVERY_ITEMS: { key: Every; label: string }[] = [
  { key: "hours", label: "Hours" },
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function RoutineModal({ routine, onClose, onSaved }: { routine: RoutineView | null; onClose: () => void; onSaved: (saved: RoutineView) => void }) {
  const catalog = useSeelie((s) => s.status?.catalog ?? null);
  const s0 = routine?.schedule;
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [every, setEvery] = useState<Every>(s0?.every ?? "week");
  const [time, setTime] = useState(s0?.time ?? "09:00");
  const [hours, setHours] = useState<HourStep>(s0?.every === "hours" ? s0.hours : 6);
  const [days, setDays] = useState<number[]>(s0?.every === "week" ? s0.days : [1]);
  const [day, setDay] = useState(String(s0?.every === "month" ? s0.day : 1));
  const [model, setModel] = useState<string | null>(routine?.model ?? useSeelie.getState().model ?? catalog?.defaultModel ?? null);
  const [thinking, setThinking] = useState<string | null>(routine?.thinking ?? useSeelie.getState().thinking ?? catalog?.defaultThinking ?? null);
  const [autoApprove, setAutoApprove] = useState(routine?.autoApprove ?? false);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const raw =
    every === "hours"
      ? { every, hours, time }
      : every === "day"
        ? { every, time }
        : every === "week"
          ? { every, days, time }
          : { every, day: Number(day), time };
  let schedule: RoutineSchedule | null = null;
  let scheduleError: string | null = null;
  try {
    schedule = checkSchedule(raw);
  } catch (err) {
    scheduleError = err instanceof Error ? err.message : "That schedule doesn't work.";
  }
  const ready = !!schedule && name.trim().length > 0 && prompt.trim().length > 0 && !busy;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!schedule || !ready) return;
    setBusy(true);
    setError(null);
    const res = await saveRoutineAction({ id: routine?.id ?? null, name, prompt, schedule, model, thinking, autoApprove, enabled });
    setBusy(false);
    if (res.ok) onSaved(res.data);
    else setError(res.error);
  }

  return (
    <Modal title={routine ? "Edit routine" : "New routine"} onClose={onClose} width="36rem">
      <form className="space-y-4" onSubmit={(e) => void save(e)}>
        <label className="block text-xs">
          <span className="muted mb-1 block">Name</span>
          <input className="input text-base sm:text-sm" placeholder="Weekly ads report" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="block text-xs">
          <span className="muted mb-1 block">What Seelie does each time</span>
          <textarea
            className="input min-h-[7rem] resize-y text-base sm:text-sm"
            placeholder="Report last week's ads: spend, clicks and cost per click for each, the best and the worst, and what you'd change. Pause any ad that's wasting money."
            maxLength={4000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="muted mt-1 block">Write it as you&apos;d ask in a chat; each run starts from this message.</span>
        </label>

        <div className="space-y-2.5">
          <span className="muted block text-xs">When (India time)</span>
          <Segmented label="How often" items={EVERY_ITEMS} value={every} onChange={setEvery} />

          {every === "hours" ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="muted">Every</span>
              <Segmented
                label="Hours between runs"
                items={HOUR_STEPS.map((h) => ({ key: String(h), label: `${h}h` }))}
                value={String(hours)}
                onChange={(h) => setHours(Number(h) as HourStep)}
              />
            </div>
          ) : null}

          {every === "week" ? (
            <div className="flex gap-1.5" role="group" aria-label="Days of the week">
              {DAY_LETTERS.map((letter, d) => {
                const on = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    aria-label={DAY_NAMES[d]}
                    title={DAY_NAMES[d]}
                    onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d].sort())}
                    className={cn("h-8 w-8 rounded-full text-xs font-semibold transition-colors", on ? "" : "muted hover:bg-[var(--tint-hover)]")}
                    style={on ? { background: "var(--accent)", color: "#fff" } : { border: "1px solid var(--border)" }}
                  >
                    {letter}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-3">
            {every === "month" ? (
              <label className="block text-xs">
                <span className="muted mb-1 block">Day of the month</span>
                <input
                  className="input w-24 text-base tabular-nums sm:text-sm"
                  inputMode="numeric"
                  value={day}
                  onChange={(e) => setDay(e.target.value.replace(/\D/g, "").slice(0, 2))}
                />
              </label>
            ) : null}
            <label className="block text-xs">
              <span className="muted mb-1 block">{every === "hours" ? "Starting at" : "At"}</span>
              <input className="input w-36 text-base tabular-nums sm:text-sm" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>

          <p className="text-xs" style={{ color: scheduleError ? "var(--danger)" : "var(--muted-2)" }}>
            {schedule ? `${describeSchedule(schedule)} · ${enabled ? `first run ${whenLabel(nextRun(schedule, new Date()))}` : "off for now"}` : scheduleError}
          </p>
        </div>

        <div className="space-y-1">
          <span className="muted block text-xs">Model</span>
          <div className="-ml-2 flex items-center gap-1">
            <ModelPicker value={model} onChange={setModel} />
            <ThinkingPicker model={model} value={thinking} onChange={setThinking} />
          </div>
        </div>

        <Toggle
          checked={autoApprove}
          onChange={setAutoApprove}
          label="Make changes to the OMS without asking"
          hint="Ads, Instagram posts, marketplace and paribelle.in changes always wait for you; a waiting run pops up when you open the OMS."
        />
        <Toggle checked={enabled} onChange={setEnabled} label="On" hint="Off keeps the routine without running it." />

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {busy ? <Spinner size="1rem" color="currentColor" /> : routine ? "Save" : "Make routine"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
