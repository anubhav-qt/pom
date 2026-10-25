"use client";

import { AlertTriangle, Camera, Check, ChevronDown, Clapperboard, FileText, Sparkles, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ToolRow } from "@/lib/seelie/types";
import { cn } from "@/lib/utils";

import { ApprovalCard } from "./cards";
import { Documents, Pictures, VideoBlock } from "./media";
import { Spinner } from "@/components/ui";
import { Bar, ItemLines, KindTag, PlanIcon, SteerBubble } from "./steps";
import { lasted, madeBy, madeAnything, nowOf, rowFor, rowsOf, splitAsk, userText, type Item, type Results, type Turn } from "./turns";

/**
 * A job's two looks. From `sm` up, the plan as a checklist (Claude Code's to-do list): each
 * step with its mark, the calls under it, the one waiting for a yes open with its card.
 * On a phone, one live card: a progress bar of the plan's steps, what's happening now with
 * how far along, the latest thing made, and the last few steps. Pinned above the box while
 * a job runs, a status bar says where it's at, with Review when something waits for a yes.
 */

export interface Ctx {
  tools: Record<string, ToolRow>;
  results: Results;
  chatId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Screen size and the clock                                                  */
/* -------------------------------------------------------------------------- */

const WIDE = "(min-width: 640px)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** From `sm` (640px) up: the plan view and the dock. */
export function useWide() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/** Now, every second while `on`. */
export function useClock(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function elapsed(turn: Turn, now: number) {
  if (!turn.startedAt) return null;
  const end = turn.live ? now : (turn.endedAt ?? now);
  return lasted(Math.max(0, end - turn.startedAt));
}

/** What a job is about, for its card's icon. */
function kindOf(turn: Turn): "video" | "photo" | "pdf" | "work" {
  const names = new Set(turn.items.flatMap((it) => (it.type === "tool" ? [it.call.name] : [])));
  if (names.has("video_plan") || names.has("video_render")) return "video";
  if (names.has("photoshoot") || names.has("photo_edit")) return "photo";
  if (names.has("pdf_edit")) return "pdf";
  return "work";
}

const JOB_ICON = { video: Clapperboard, photo: Camera, pdf: FileText, work: Sparkles };

function titleOf(turn: Turn) {
  if (turn.plan?.title) return turn.plan.title;
  const kind = kindOf(turn);
  if (kind === "video") return turn.live ? "Making the video" : "Made the video";
  if (kind === "photo") return turn.live ? "Working on the photos" : "Photos";
  if (kind === "pdf") return turn.live ? "Working on the PDF" : "Made the PDF";
  return turn.live ? "Working on it" : "Worked through it";
}

/* -------------------------------------------------------------------------- */
/* Wide: the plan checklist                                                   */
/* -------------------------------------------------------------------------- */

export function PlanView({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const plan = turn.plan!;
  const now = useClock(turn.live);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const n = plan.steps.length;
  return (
    <section className="sl-plan">
      <header className="sl-plan-head">
        <span className="t">{plan.title ?? "Plan"}</span>
        <span className="n">
          {plan.finished} of {n} done
        </span>
        <span className="el">{elapsed(turn, now)}</span>
      </header>
      <Bar pct={plan.finished / n} className="mx-3 mb-2 w-auto" />
      <ol className="sl-prows">
        {plan.steps.map((step, i) => {
          const calls = step.items.filter((it) => it.type === "tool").length;
          const isOpen = open[i] ?? (turn.live && (step.state === "active" || step.state === "ask"));
          const running = step.items.flatMap((it) => (it.type === "tool" ? [ctx.tools[it.call.id]] : [])).find((r) => r?.status === "running" && r.progress);
          const pct = running ? /(\d{1,3})\s?%/.exec(running.progress ?? "")?.[1] : null;
          const meta =
            step.state === "ask" ? (
              <span className="sl-chip-ask">Needs your OK</span>
            ) : step.state === "active" ? (
              <span className="meta">{pct ? `${pct}%` : ""}</span>
            ) : step.state === "done" ? (
              <span className="meta">{calls ? `${calls} step${calls === 1 ? "" : "s"}` : ""}</span>
            ) : step.state === "skipped" ? (
              <span className="meta">Skipped</span>
            ) : step.state === "ended" ? (
              <span className="meta">{turn.ended === "stopped" ? "Stopped here" : "Not finished"}</span>
            ) : step.asks ? (
              <span className="meta ask-hint">Will ask you</span>
            ) : (
              <span />
            );
          return (
            <li key={i} className={cn("sl-prow", step.state)}>
              <button type="button" disabled={!step.items.length} aria-expanded={isOpen} onClick={() => setOpen({ ...open, [i]: !isOpen })}>
                <PlanIcon state={step.state} />
                <span className="txt">{step.text}</span>
                {meta}
                <ChevronDown className={cn("sl-chev h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")} />
              </button>
              {isOpen && step.items.length ? (
                <div className="sl-pbody">
                  <ItemLines items={step.items} ctx={ctx} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Phones: the live card                                                      */
/* -------------------------------------------------------------------------- */

/** A finished step on the card's feed: a tick, its name and its line. */
function FeedLine({ item, ctx }: { item: Item; ctx: Ctx }) {
  if (item.type === "steer") return <SteerBubble text={item.entry ? userText(item.entry) : (item.pending?.text ?? "")} sending={!!item.pending} />;
  if (item.type === "text")
    return (
      <p className="sl-fi-say">
        <span className="line-clamp-2">{item.text}</span>
      </p>
    );
  if (item.type === "error" || item.type === "stopped")
    return (
      <div className={cn("sl-fi", item.type === "error" ? "error" : "denied")}>
        <span className="sl-fi-ic">{item.type === "error" ? <AlertTriangle className="h-3 w-3" /> : <X className="h-3 w-3" />}</span>
        <span className="sl-fi-t">{item.type === "error" ? item.text : "Stopped."}</span>
      </div>
    );
  if (item.type !== "tool") return null;
  const row = rowFor(item.call, ctx.tools, ctx.results);
  const { ask } = splitAsk(row.args);
  const tone = row.status === "error" ? "error" : row.status === "denied" ? "denied" : "done";
  return (
    <div className={cn("sl-fi", tone)}>
      <span className="sl-fi-ic">{tone === "error" ? <AlertTriangle className="h-3 w-3" /> : tone === "denied" ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" strokeWidth={3} />}</span>
      <span className="sl-fi-t">
        <b>{row.label}</b> <span className={tone === "error" ? "err" : undefined}>{row.status === "denied" ? "you said not now" : (ask ?? row.summary ?? "")}</span> <KindTag kind={row.kind} />
      </span>
    </div>
  );
}

export function LiveCard({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const now = useClock(turn.live);
  const [all, setAll] = useState(false);
  const plan = turn.plan;
  const Icon = JOB_ICON[kindOf(turn)];
  const made = madeBy(turn.items, ctx.results, ctx.tools);
  const asking = rowsOf(turn, ctx.tools).filter((r) => r.status === "awaiting");
  const finished = turn.work.filter((it) => {
    if (it.type === "thinking") return false;
    if (it.type !== "tool") return true;
    const s = ctx.tools[it.call.id]?.status;
    return s !== "running" && s !== "queued" && s !== "awaiting";
  });

  if (!turn.live) {
    const approvals = rowsOf(turn, ctx.tools).filter((r) => r.approval === "approved" || r.approval === "denied").length;
    return (
      <section className="sl-job">
        <button type="button" className="sl-job-sum" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          <span className={cn("sl-job-ic", turn.ended === "done" ? "ok" : "warn")}>{turn.ended === "done" ? <Check className="h-4 w-4" strokeWidth={2.6} /> : <AlertTriangle className="h-4 w-4" />}</span>
          <span className="sl-job-tt">
            <b>{titleOf(turn)}</b>
            <small>
              {[elapsed(turn, now), `${turn.calls} step${turn.calls === 1 ? "" : "s"}`, approvals ? `${approvals} approval${approvals === 1 ? "" : "s"}` : null, turn.ended === "stopped" ? "stopped" : turn.ended === "error" ? "ended with an error" : null]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
          <ChevronDown className={cn("sl-chev h-4 w-4 transition-transform", all && "rotate-180")} />
        </button>
        {plan && !all ? <Stepper turn={turn} /> : null}
        {madeAnything(made) ? (
          <div className="px-3.5 pb-3">
            {made.videos.map((v) => (
              <div key={v.src} className="mt-2">
                <VideoBlock video={v} size="sm" />
              </div>
            ))}
            {made.pictures.length ? <Pictures pictures={made.pictures} /> : null}
            {made.documents.length ? <Documents documents={made.documents} /> : null}
          </div>
        ) : null}
        {all ? (
          <div className="px-3.5 pb-3">
            <ItemLines items={turn.work} ctx={ctx} />
          </div>
        ) : null}
      </section>
    );
  }

  const live = nowOf(turn, ctx.tools);
  const preview = { videos: made.videos.slice(-1), pictures: made.pictures.slice(-4), documents: [] };
  const shown = all ? finished : finished.slice(-3);
  return (
    <section className={cn("sl-job", asking.length && "asking")}>
      <header className="sl-job-head">
        <span className="sl-job-ic">
          <Icon className="h-[17px] w-[17px]" />
        </span>
        <span className="sl-job-tt">
          <b>{titleOf(turn)}</b>
          <small>
            {elapsed(turn, now)} · {turn.calls} step{turn.calls === 1 ? "" : "s"} so far
          </small>
        </span>
        {asking.length ? null : <Spinner size="1.1rem" className="ml-auto shrink-0" />}
      </header>
      {plan ? <Stepper turn={turn} /> : null}
      {asking.length ? (
        <div className="space-y-2 px-3.5 pt-3">
          {asking.map((r) => (
            <ApprovalCard key={r.callId} row={r} />
          ))}
        </div>
      ) : (
        <div className="sl-now">
          <div className="sl-now-line">
            <span className="sl-now-t sl-shimmer">{live.text}</span>
            {live.pct !== null ? <span className="pct">{Math.round(live.pct * 100)}%</span> : null}
          </div>
          {live.pct !== null ? <Bar pct={live.pct} /> : null}
          {madeAnything(preview) ? (
            <div>
              {preview.videos.map((v) => (
                <VideoBlock key={v.src} video={v} size="sm" />
              ))}
              {preview.pictures.length ? <Pictures pictures={preview.pictures} small /> : null}
            </div>
          ) : null}
        </div>
      )}
      <div className="sl-feed">
        {all ? (
          <ItemLines items={turn.work} ctx={ctx} />
        ) : (
          shown.map((it) => <FeedLine key={it.key} item={it} ctx={ctx} />)
        )}
        {finished.length > 3 ? (
          <button type="button" className="sl-more" onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : `See all ${finished.length} steps`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The plan as a bar of segments, with each step's word or two under it. */
function Stepper({ turn, mini }: { turn: Turn; mini?: boolean }) {
  const steps = turn.plan?.steps ?? [];
  return (
    <div className={mini ? "sl-stepper mini" : undefined}>
      <div className="sl-stepper-bar" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <span key={i} className={cn("sl-sg", s.state)} title={s.text} />
        ))}
      </div>
      {mini ? null : (
        <div className="sl-steplabels" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => (
            <span key={i} className={s.state}>
              {s.short}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small job (a lookup or two): one line that opens to its steps. */
export function ChipLine({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const rows = turn.work.flatMap((it) => (it.type === "tool" ? [rowFor(it.call, ctx.tools, ctx.results)] : []));
  const thinking = turn.work.find((it): it is Extract<Item, { type: "thinking" }> => it.type === "thinking" && it.live);
  const running = rows.find((r) => r.status === "running" || r.status === "queued");
  if (!rows.length && thinking) {
    return (
      <span className="sl-chip-line">
        <span className="sl-shimmer">Thinking…</span>
      </span>
    );
  }
  if (!rows.length) return null;
  const labels = [...new Set(rows.map((r) => r.label.toLowerCase()))];
  const secs = turn.thoughtMs ? ` · thought ${Math.round(turn.thoughtMs / 1000)} s` : "";
  return (
    <div>
      <button type="button" className="sl-chip-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {running ? (
          <>
            <span className="sl-shimmer truncate">{running.label}…</span>
          </>
        ) : (
          <>
            <PlanIcon state={rows.some((r) => r.status === "error") ? "ask" : "done"} small />
            <span className="truncate">
              Checked {labels.join(", ")}
              {secs}
            </span>
          </>
        )}
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <ItemLines items={turn.work} ctx={ctx} className="mt-2.5" /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pinned above the box                                                       */
/* -------------------------------------------------------------------------- */

/** Where the running job is, pinned above the box; Review jumps to what waits for a yes. */
export function PinBar({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const live = nowOf(turn, ctx.tools);
  const plan = turn.plan;
  const at = plan ? plan.steps.findIndex((s) => s.state === "active" || s.state === "ask") : -1;
  const review = () => {
    const el = live.asking ? document.getElementById(`approval-${live.asking.callId}`) : null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // One loader on screen: the bar shows only while the chat's own spinner (or the card
  // waiting for a yes) is out of sight, above the header or behind the box.
  const waiting = live.asking?.callId ?? null;
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const look = () => {
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--seelie-top")) || 0;
      const bottom = document.querySelector(".sl-dock .sl-box1, .sl-dock .sl-box2")?.getBoundingClientRect().top ?? window.innerHeight;
      const marks = waiting
        ? [document.getElementById(`approval-${waiting}`)]
        : Array.from(document.querySelectorAll(".sl-shimmer, .dot-spinner")).filter((el) => !el.closest(".sl-dock"));
      setSeen(
        marks.some((el) => {
          const r = el?.getBoundingClientRect();
          return !!r && r.height > 0 && r.bottom > top && r.top < bottom;
        }),
      );
    };
    look();
    const t = setInterval(look, 400);
    window.addEventListener("scroll", look, { passive: true });
    window.addEventListener("resize", look);
    return () => {
      clearInterval(t);
      window.removeEventListener("scroll", look);
      window.removeEventListener("resize", look);
    };
  }, [waiting]);
  if (seen && !open) return null;
  return (
    <div className={cn("sl-pin", live.asking && "asking")}>
      {open && plan ? (
        <ol className="sl-pin-list">
          {plan.steps.map((s, i) => (
            <li key={i} className={s.state}>
              <PlanIcon state={s.state} small />
              <span className="truncate">{s.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="sl-pin-row">
        <button type="button" className="sl-pin-main" onClick={() => (plan ? setOpen((v) => !v) : review())} aria-expanded={plan ? open : undefined}>
          {plan && !wide ? <Stepper turn={turn} mini /> : null}
          <span className="sl-pin-t">
            {wide && plan && at >= 0 ? (
              <>
                <span style={{ color: live.asking ? "var(--warn-ink)" : "var(--accent-ink)", fontWeight: 600 }}>
                  Step {at + 1} of {plan.steps.length}
                </span>{" "}
                {plan.steps[at].text}
                <span className="muted"> · {live.text}</span>
              </>
            ) : (
              live.text
            )}
          </span>
        </button>
        {live.asking ? null : <Spinner size="1rem" className="shrink-0" />}
        {live.pct !== null && !live.asking ? <span className="pct">{Math.round(live.pct * 100)}%</span> : null}
        {live.asking ? (
          <button type="button" className="btn btn-blue px-2.5 py-1 text-xs" onClick={review}>
            Review
          </button>
        ) : null}
      </div>
      {live.pct !== null && !live.asking ? <Bar pct={live.pct} className="sl-bar-edge" /> : null}
    </div>
  );
}
