"use client";

import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CalendarPlus,
  Camera,
  Check,
  ChevronDown,
  CircleDashed,
  Clapperboard,
  ExternalLink,
  FileText,
  GalleryHorizontal,
  Image as ImageIcon,
  Megaphone,
  Minus,
  Music,
  Package,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Tag,
  Trash2,
  TrendingUp,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Spinner } from "@/components/ui";
import type { ApprovalCard as Card, ApprovalEdits, CardMedia, ToolKind, ToolRow } from "@/lib/seelie/types";
import { useSeelie } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { approvalCardAction } from "./actions";
import { Details, KindTag } from "./steps";
import { PLACE, splitAsk, type Change, type ChangeIcon, type Turn } from "./turns";

/**
 * The cards a job shows the owner: before something goes out (a post, an ad, more budget, a
 * photoshoot) a card made for it, with what goes out, what it costs and what's left, the
 * parts worth changing editable in place; after a change, a card saying what changed and
 * where, with Undo. Built so a glance is enough; the exact call stays one tap below.
 */

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
};

const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

/** What each kind of change is, on a card without one of its own. */
const ASKS: Record<ToolKind, string> = {
  read: "",
  write: "This changes the OMS.",
  market: "This changes Amazon.",
  store: "This changes paribelle.in.",
  publish: "This posts publicly.",
  spend: "This uses the image model's limited budget.",
  ads: "This can spend money on Meta ads.",
  forget: "This deletes something Seelie remembers for you.",
};

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

/** Cards already read, by call: the screen redraws often. */
const cards = new Map<string, Card | null>();

function useCard(row: ToolRow) {
  const key = `${row.runId}:${row.callId}`;
  const [card, setCard] = useState<Card | null | undefined>(() => (cards.has(key) ? cards.get(key) : undefined));
  useEffect(() => {
    if (cards.has(key)) return setCard(cards.get(key));
    let live = true;
    void approvalCardAction(row.runId, row.callId)
      .then((res) => {
        const c = res.ok ? res.data : null;
        cards.set(key, c);
        if (live) setCard(c);
      })
      .catch(() => live && setCard(null));
    return () => {
      live = false;
    };
  }, [key, row.runId, row.callId]);
  return card;
}

/** A change waiting for a yes, as its card. `id` lets the pinned bar's Review jump to it. */
export function ApprovalCard({ row }: { row: ToolRow }) {
  const card = useCard(row);
  const { ask } = splitAsk(row.args);
  const headline = ask ?? row.summary ?? row.label;
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<ApprovalEdits>({});
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => {
    setBusy(true);
    void useSeelie
      .getState()
      .decide(row, approve, approve && Object.keys(edits).length ? edits : null)
      .finally(() => setBusy(false));
  };

  const look = card ? LOOK[card.type === "post" ? `post-${card.post}` : card.type] : LOOK.generic;
  const yes = card ? yesLabel(card, edits) : "Approve";
  const blocked = card?.type === "shoot" && (edits.lookIds ? edits.lookIds.length === 0 : card.images === 0);

  return (
    <div id={`approval-${row.callId}`} className="sl-ask scroll-mt-24">
      <div className="sl-ask-top">
        <span className="sl-ask-ic">
          <look.icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-snug">{headline}</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--warn-ink)" }}>
            {card ? whyLine(card) : card === null ? `Seelie is asking first. ${ASKS[row.kind]}` : "Seelie is asking first."}
          </p>
        </div>
      </div>

      {card === undefined ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs" style={{ color: "var(--muted)" }}>
          <Spinner size="0.9rem" /> Getting the details…
        </div>
      ) : card ? (
        <div className="space-y-2.5 px-3 pb-1 pt-2.5">
          {card.type === "post" ? <PostBody card={card} edits={edits} setEdits={setEdits} /> : null}
          {card.type === "ad" ? <AdBody card={card} edits={edits} setEdits={setEdits} /> : null}
          {card.type === "ad-change" ? <AdChangeBody card={card} edits={edits} setEdits={setEdits} /> : null}
          {card.type === "shoot" ? <ShootBody card={card} edits={edits} setEdits={setEdits} /> : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" className="btn btn-white flex-1 px-3 py-2 text-[13px] sm:py-1.5" disabled={busy} onClick={() => decide(false)}>
          Not now
        </button>
        <button type="button" className="btn btn-blue flex-[1.4] px-3 py-2 text-[13px] sm:py-1.5" disabled={busy || blocked} onClick={() => decide(true)}>
          {busy ? <Spinner size="0.9rem" /> : <Check className="h-3.5 w-3.5" />}
          {yes}
        </button>
      </div>
      <div className="px-3 pb-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="muted flex items-center gap-1 text-xs hover:text-[var(--text)]">
          {open ? "Hide the details" : "See exactly what it runs"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div className="mt-2">
            <Details row={row} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const LOOK: Record<string, { icon: LucideIcon }> = {
  "post-reel": { icon: Clapperboard },
  "post-photo": { icon: ImageIcon },
  "post-carousel": { icon: GalleryHorizontal },
  "post-story": { icon: CircleDashed },
  ad: { icon: Megaphone },
  "ad-change": { icon: TrendingUp },
  shoot: { icon: Camera },
  generic: { icon: AlertTriangle },
};

function whyLine(card: Card): string {
  switch (card.type) {
    case "post":
      return `Goes up publicly${card.account ? ` on ${card.account}` : " on Instagram"}${card.post === "story" ? " for 24 hours" : ""}.`;
    case "ad":
      return card.room?.cap ? `Can spend real money: ${money(card.room.room, card.currency)} of the ${money(card.room.cap, card.currency)} monthly cap is free.` : "Can spend real money on Meta ads.";
    case "ad-change":
      return card.action === "archive" ? "Archived ads can't be switched back on." : "It can spend more money once you say yes.";
    case "shoot":
      return card.blocked
        ? `No images left until about ${card.comesBack ? when(card.comesBack) : "later"}: the looks will wait.`
        : `Uses ${card.images} of the ${card.left ?? "?"} images left now (of ~${card.capacity ?? "?"} per 5 hours).`;
  }
}

function yesLabel(card: Card, edits: ApprovalEdits): string {
  switch (card.type) {
    case "post":
      return card.post === "story" ? "Post the story" : `Post the ${card.post}`;
    case "ad":
      return `Start it · ${money(edits.budget ?? card.budget, card.currency)}`;
    case "ad-change":
      return card.action === "resume" ? "Switch it on" : card.action === "raise_budget" ? `Raise to ${money(edits.budget ?? card.budget ?? 0, card.currency)}` : card.action === "extend" ? "Run it longer" : "Archive it";
    case "shoot": {
      const n = edits.lookIds ? edits.lookIds.length : card.images;
      return `Make ${n} picture${n === 1 ? "" : "s"}`;
    }
  }
}

type BodyProps<T extends Card["type"]> = { card: Extract<Card, { type: T }>; edits: ApprovalEdits; setEdits: (e: ApprovalEdits) => void };

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
      {children}
    </span>
  );
}

/** A picture or a video on a card. */
function Media({ m, tall }: { m: CardMedia; tall?: boolean }) {
  const cls = cn("shrink-0 overflow-hidden rounded-lg border object-cover", tall ? "h-40 w-[5.6rem]" : "h-20 w-16");
  if (!m.src) {
    return (
      <span className={cn(cls, "flex items-center justify-center text-[10px]")} style={{ borderColor: "var(--border)", background: "var(--panel-2)", color: "var(--muted)" }}>
        {m.ref}
      </span>
    );
  }
  return m.kind === "video" ? (
    <video src={m.src} poster={m.poster ?? undefined} controls playsInline preload="metadata" className={cn(cls, "bg-black")} style={{ borderColor: "var(--border)" }} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={m.src} alt={m.ref} className={cls} style={{ borderColor: "var(--border)" }} />
  );
}

function PostBody({ card, edits, setEdits }: BodyProps<"post">) {
  const [editing, setEditing] = useState(false);
  const caption = edits.caption ?? card.caption;
  const feed = edits.shareToFeed ?? card.shareToFeed;
  return (
    <>
      <div className="flex gap-2 overflow-x-auto">
        {card.items.map((m) => (
          <Media key={m.ref} m={m} tall={card.post === "reel" || card.post === "story"} />
        ))}
      </div>
      {card.post !== "story" ? (
        <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
          <div className="flex items-center gap-2">
            <Label>Caption</Label>
            <button type="button" className="ml-auto flex items-center gap-1 text-[11px] font-medium" style={{ color: "var(--accent-ink)" }} onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-3 w-3" />
              {editing ? "Done" : "Edit"}
            </button>
          </div>
          {editing ? (
            <textarea
              value={caption}
              onChange={(e) => setEdits({ ...edits, caption: e.target.value })}
              rows={5}
              maxLength={2200}
              className="input mt-1 resize-y text-base leading-relaxed sm:text-[13px]"
            />
          ) : (
            <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">{caption || <span className="muted">No caption.</span>}</p>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5 text-[11.5px]">
        {card.post === "reel" ? (
          <button
            type="button"
            onClick={() => setEdits({ ...edits, shareToFeed: !feed })}
            className="sl-pill"
            aria-pressed={feed}
            title="Reels also show on the profile's main grid unless this is off"
          >
            <span className={cn("sl-check", feed && "on")}>{feed ? <Check className="h-2.5 w-2.5" /> : null}</span>
            On the main grid too
          </button>
        ) : null}
        {card.aiLabel ? (
          <span className="sl-pill" title="Meta's 'AI info' label: a picture came from the image model">
            <Sparkles className="h-3 w-3" /> AI info label
          </span>
        ) : null}
        {card.collaborators.length ? <span className="sl-pill">With {card.collaborators.join(", ")}</span> : null}
      </div>
      {card.song ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--warn-ink)" }}>
          <Music className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          It has a library song ({card.song}): Instagram may mute a commercial track.
        </p>
      ) : null}
    </>
  );
}

/** A small "− 7 days +" stepper. */
function Stepper({ value, min, max, onChange, unit }: { value: number; min: number; max: number; onChange: (n: number) => void; unit: (n: number) => string }) {
  return (
    <span className="inline-flex items-center rounded-lg border" style={{ borderColor: "var(--border-strong)", background: "var(--panel)" }}>
      <button type="button" className="btn rounded-r-none p-1.5" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="Less">
        <Minus className="h-3 w-3" />
      </button>
      <span className="min-w-[4.5rem] text-center text-[13px] font-medium tabular-nums">{unit(value)}</span>
      <button type="button" className="btn rounded-l-none p-1.5" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="More">
        <Plus className="h-3 w-3" />
      </button>
    </span>
  );
}

/** A budget slider, up to what's free under the monthly cap. */
function Budget({ value, asked, room, currency, onChange }: { value: number; asked: number; room: number | null; currency: string; onChange: (n: number) => void }) {
  const top = Math.max(asked, room && room > 0 ? room : asked * 3);
  const step = top > 20_000 ? 500 : top > 2_000 ? 50 : 10;
  const over = room !== null && value > room + 0.005;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <Label>Budget</Label>
        <span className="ml-auto text-[15px] font-semibold tabular-nums">{money(value, currency)}</span>
      </div>
      <input type="range" min={step} max={Math.ceil(top / step) * step} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[var(--accent)]" aria-label="Budget" />
      {over ? (
        <p className="text-[11.5px]" style={{ color: "var(--danger)" }}>
          More than the {money(room!, currency)} free under the cap: Meta won&apos;t be asked; lower it or raise the cap in settings.
        </p>
      ) : value !== asked ? (
        <p className="muted text-[11.5px]">Seelie asked for {money(asked, currency)}.</p>
      ) : null}
    </div>
  );
}

/** Spent, held by running ads, and free, against the monthly cap. */
function RoomBar({ room, currency, adding, balance }: { room: NonNullable<Extract<Card, { type: "ad" }>["room"]>; currency: string; adding: number; balance: number | null }) {
  if (!room.cap) return null;
  const share = (n: number) => `${Math.max(0, Math.min(100, (n / room.cap!) * 100))}%`;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
        <span style={{ width: share(room.spentThisMonth), background: "var(--muted-2)" }} />
        <span style={{ width: share(room.committed), background: "color-mix(in srgb, var(--accent) 45%, transparent)" }} />
        <span style={{ width: share(adding), background: adding > room.room ? "var(--danger)" : "var(--accent)" }} />
      </div>
      <p className="muted mt-1 text-[11px] tabular-nums">
        {money(room.spentThisMonth, currency)} spent · {money(room.committed, currency)} held by running ads · this {money(adding, currency)} · cap {money(room.cap, currency)}
      </p>
      {balance !== null && balance < adding ? (
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--warn-ink)" }}>
          Only {money(balance, currency)} is on the prepaid balance; Meta stops the ad when it runs out.
        </p>
      ) : null}
    </div>
  );
}

function AdBody({ card, edits, setEdits }: BodyProps<"ad">) {
  const budget = edits.budget ?? card.budget;
  const days = edits.days ?? card.days;
  return (
    <>
      <div className="flex gap-2.5">
        {card.creative ? <Media m={card.creative} tall={card.creative.kind === "video"} /> : null}
        <div className="min-w-0 flex-1 space-y-1 text-[12.5px]">
          <p className="font-semibold">{card.name}</p>
          <p className="muted">{card.objective}</p>
          {card.post ? <p className="muted">Promotes Instagram post {card.post}</p> : null}
          {card.headline ? <p>“{card.headline}”</p> : null}
          {card.text ? <p className="muted line-clamp-3">{card.text}</p> : null}
          {card.link ? (
            <a href={card.link} target="_blank" rel="noopener" className="flex items-center gap-1 truncate" style={{ color: "var(--accent-ink)" }}>
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{card.link.replace(/^https:\/\//, "")}</span>
            </a>
          ) : null}
        </div>
      </div>
      <Budget value={budget} asked={card.budget} room={card.room?.room ?? null} currency={card.currency} onChange={(n) => setEdits({ ...edits, budget: n })} />
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <Label>For</Label>
        {days !== null ? (
          <Stepper value={days} min={1} max={30} onChange={(n) => setEdits({ ...edits, days: n })} unit={(n) => `${n} day${n === 1 ? "" : "s"}`} />
        ) : (
          <span>until {card.until}</span>
        )}
        <span className="muted">· {card.audience}</span>
      </div>
      <p className="muted text-[11.5px]">{card.placements}</p>
      {card.room ? <RoomBar room={card.room} currency={card.currency} adding={budget} balance={card.balance} /> : null}
    </>
  );
}

function AdChangeBody({ card, edits, setEdits }: BodyProps<"ad-change">) {
  const Icon = card.action === "resume" ? Play : card.action === "extend" ? CalendarPlus : card.action === "archive" ? Archive : TrendingUp;
  const budget = edits.budget ?? card.budget;
  return (
    <>
      <p className="flex items-center gap-2 text-[13px]">
        <Icon className="h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
        <span className="font-medium">{card.what}</span>
      </p>
      {card.action === "raise_budget" && budget !== null ? (
        <>
          {card.was !== null ? (
            <p className="flex items-center gap-1.5 text-[13px] tabular-nums">
              <span className="muted line-through">{money(card.was, card.currency)}</span>
              <ArrowRight className="h-3.5 w-3.5" style={{ color: "var(--muted-2)" }} />
              <span className="font-semibold">{money(budget, card.currency)}</span>
            </p>
          ) : null}
          <Budget value={budget} asked={card.budget ?? budget} room={card.room ? card.room.room + (card.was ?? 0) : null} currency={card.currency} onChange={(n) => setEdits({ ...edits, budget: n })} />
        </>
      ) : null}
      {card.action === "extend" && card.end ? <p className="text-[13px]">Runs until {card.end}.</p> : null}
      {card.room && card.action !== "archive" ? <RoomBar room={card.room} currency={card.currency} adding={Math.max(0, (budget ?? 0) - (card.was ?? 0))} balance={card.balance} /> : null}
    </>
  );
}

function ShootBody({ card, edits, setEdits }: BodyProps<"shoot">) {
  const chosen = edits.lookIds ?? card.looks.map((l) => l.id);
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    setEdits({ ...edits, lookIds: card.looks.filter((l) => next.includes(l.id)).map((l) => l.id) });
  };
  const n = chosen.length;
  const short = card.left !== null && !card.blocked && card.left < n;
  return (
    <>
      <div className="flex gap-2.5">
        {card.product ? <Media m={card.product} /> : null}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{card.title}</p>
          <p className="muted text-[11.5px]">Untick a look to leave it out.</p>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {card.looks.map((l) => {
          const on = chosen.includes(l.id);
          return (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => toggle(l.id)}
                aria-pressed={on}
                className="flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left text-[12px]"
                style={{ borderColor: on ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "var(--border)", background: on ? "var(--panel)" : "var(--panel-2)", opacity: on ? 1 : 0.65 }}
              >
                <span className={cn("sl-check mt-0.5", on && "on")}>{on ? <Check className="h-2.5 w-2.5" /> : null}</span>
                <span className="min-w-0">
                  <span className="font-medium">{l.id}</span>
                  <span className="muted block">{l.line}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {short ? (
        <p className="text-[11.5px]" style={{ color: "var(--warn-ink)" }}>
          Only {card.left} left now: {n - card.left!} will wait until about {card.comesBack ? when(card.comesBack) : "the budget is back"}.
        </p>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

const CHANGE_ICON: Record<ChangeIcon, LucideIcon> = {
  price: Tag,
  new: Plus,
  remove: Trash2,
  stock: Package,
  post: Camera,
  ad: Megaphone,
  photo: ImageIcon,
  video: Clapperboard,
  memory: Sparkles,
  routine: CalendarPlus,
  page: FileText,
  order: Package,
  edit: Pencil,
};

/** What changed, where, and Undo (which asks Seelie to put it back). */
export function ChangeCard({ change }: { change: Change }) {
  const [undone, setUndone] = useState(false);
  const Icon = CHANGE_ICON[change.icon];
  const [all, setAll] = useState(false);
  const lines = all ? change.lines : change.lines.slice(0, 3);
  return (
    <div className="sl-change">
      <span className="sl-change-ic">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 text-[13px] font-medium leading-snug">{change.headline}</span>
          <KindTag kind={change.row.kind} />
        </div>
        {lines.length ? (
          <ul className="mt-1 space-y-0.5">
            {lines.map((l, i) => (
              <li key={i} className="text-[12px] leading-snug">
                {l.url ? (
                  <a href={l.url} target="_blank" rel="noopener" className="font-medium hover:underline">
                    {l.name}
                  </a>
                ) : (
                  <span className="font-medium">{l.name}</span>
                )}
                {l.detail.length ? <span className="muted"> · {l.detail.join(" · ")}</span> : null}
              </li>
            ))}
            {change.lines.length > 3 ? (
              <li>
                <button type="button" className="text-[11.5px] font-medium" style={{ color: "var(--accent-ink)" }} onClick={() => setAll((v) => !v)}>
                  {all ? "Fewer" : `${change.lines.length - 3} more`}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {change.link || change.undo ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {change.link ? (
              <a href={change.link.href} target="_blank" rel="noopener" className="btn btn-white px-2 py-1 text-[12px]">
                <ExternalLink className="h-3 w-3" />
                {change.link.label}
              </a>
            ) : null}
            {change.undo ? (
              <button
                type="button"
                className="btn btn-white px-2 py-1 text-[12px]"
                disabled={undone}
                onClick={() => {
                  setUndone(true);
                  void useSeelie.getState().say(change.undo!.say);
                }}
              >
                {change.undo.label === "Undo" ? <Undo2 className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
                {undone ? "Asked Seelie" : change.undo.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChangeList({ changes }: { changes: Change[] }) {
  if (!changes.length) return <p className="muted text-sm">Nothing changed in this chat yet.</p>;
  return (
    <div className="space-y-2">
      {changes.map((c) => (
        <ChangeCard key={c.key} change={c} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The wrap-up                                                                */
/* -------------------------------------------------------------------------- */

/** How a finished job went in one line, what it changed, and what the owner may want next. */
export function WrapBox({ turn, changes, children }: { turn: Turn; changes: Change[]; children?: React.ReactNode }) {
  const say = useSeelie((s) => s.say);
  const places = useMemo(() => [...new Set(changes.map((c) => PLACE[c.row.kind]).filter(Boolean))], [changes]);
  const next = turn.plan?.next ?? [];
  const took = turn.startedAt && turn.endedAt ? turn.endedAt - turn.startedAt : null;
  if (!changes.length && !next.length && !children) return null;
  return (
    <div className="sl-wrap">
      <p className="flex flex-wrap items-center gap-x-1.5 text-[12.5px]" style={{ color: "var(--muted)" }}>
        {turn.ended === "done" ? <Check className="h-3.5 w-3.5" style={{ color: "var(--ok)" }} /> : <AlertTriangle className="h-3.5 w-3.5" style={{ color: "var(--warn)" }} />}
        {[
          turn.ended === "stopped" ? "Stopped" : turn.ended === "error" ? "Ended with an error" : "Done",
          took ? `in ${lastedShort(took)}` : null,
          `${turn.calls} step${turn.calls === 1 ? "" : "s"}`,
          changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}${places.length ? ` (${places.join(", ")})` : ""}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {children}
      {changes.length ? (
        <div className="space-y-1.5">
          {changes.map((c) => (
            <ChangeCard key={c.key} change={c} />
          ))}
        </div>
      ) : null}
      {next.length ? (
        <div className="flex flex-wrap gap-1.5">
          {next.map((n) => (
            <button key={n} type="button" className="btn btn-white px-2.5 py-1.5 text-[12.5px]" onClick={() => void say(n)}>
              {n}
              <ArrowRight className="h-3 w-3" style={{ color: "var(--muted-2)" }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function lastedShort(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}
