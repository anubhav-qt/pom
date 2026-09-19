"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Layers,
  Printer,
  Tags,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 4.4 * 1024 * 1024;

export interface FileItem {
  id: string;
  name: string;
  size: number;
}

/** Mirrors the POST /api/label-print response (see the route handler). */
export interface RunFileReport {
  name: string;
  pages: number;
  labels: number;
  skipped: { pageIndex: number; kind: string; reason: string }[];
  error?: string;
}

export interface RunResult {
  id: number;
  url: string;
  labels: number;
  sheets: number;
  files: RunFileReport[];
  duplicates: string[];
  framesRemoved: number;
  unstamped: number;
}

export type Phase = "idle" | "processing" | "done" | "error";

export interface PrinterOptions {
  stamp: boolean;
  cutGuides: boolean;
}

export interface PrinterViewProps {
  files: FileItem[];
  phase: Phase;
  options: PrinterOptions;
  result?: RunResult | null;
  error?: { message: string; files?: RunFileReport[] } | null;
  /** Shown when the browser blocked the new tab, so the sheet is one click away. */
  popupBlocked?: boolean;
  onAddFiles?: (files: File[]) => void;
  onRemove?: (id: string) => void;
  onClear?: () => void;
  onOptions?: (o: PrinterOptions) => void;
  onBuild?: () => void;
  onReset?: () => void;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Only the pages the person cares about: things that were left out and why. */
function skippedSummary(f: RunFileReport) {
  if (f.error) return f.error;
  if (f.skipped.length === 0) return null;
  const invoices = f.skipped.filter((s) => s.kind === "invoice").length;
  const other = f.skipped.length - invoices;
  const parts = [];
  if (invoices) parts.push(`${invoices} invoice page${invoices === 1 ? "" : "s"} used for the stamp`);
  if (other) parts.push(`${other} page${other === 1 ? "" : "s"} not recognised`);
  return parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* Main view                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The PDF printer screen, as pure presentation: everything it shows comes in as
 * props, so the live page and the design demo render the exact same markup.
 * Desktop is a two-column workspace; below `lg` it stacks, and below `sm` the
 * action bar docks to the bottom of the screen like the orders bottom nav.
 */
export function PrinterView(props: PrinterViewProps) {
  const { files, phase, result, error } = props;

  // Always open at the top, and keep the page itself still on phones.
  useEffect(() => {
    window.scrollTo(0, 0);
    const root = document.documentElement;
    root.classList.add("printer-lock");
    return () => root.classList.remove("printer-lock");
  }, []);
  const total = files.reduce((n, f) => n + f.size, 0);
  const overSize = total > MAX_TOTAL_BYTES;
  const overCount = files.length > MAX_FILES;
  const busy = phase === "processing";
  const canBuild = files.length > 0 && !overSize && !overCount && !busy;

  return (
    // Below `lg` this is exactly one screen tall: the viewport minus the header,
    // the page padding and the docked action bar. Nothing scrolls the page.
    <div className="printer-surface flex h-[calc(100dvh-57px-24px-76px-56px-env(safe-area-inset-bottom))] flex-col sm:h-[calc(100dvh-57px-24px-76px-env(safe-area-inset-bottom))] overflow-hidden lg:block lg:h-auto lg:overflow-visible lg:pb-0">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-x-5 lg:flex-none lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-none">
        {/* ------------------------------------------------------ left column -- */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain lg:block lg:overflow-visible">
          <Presence value={phase === "done" && result}>{(r) => <ResultHead result={r} />}</Presence>
          <Presence value={phase === "done" && result && hasWarnings(result) && result}>{(r) => <Warnings result={r} />}</Presence>
          <Presence value={phase === "error" && error}>{(e) => <ErrorHead error={e} />}</Presence>
          <div className={cn("pb-3 lg:pb-5", files.length === 0 && "flex flex-1 flex-col lg:block")}>
            <Dropzone {...props} disabled={busy} compact={files.length > 0} />
          </div>
          <Presence value={files.length > 0}>
            {() => <FileList {...props} total={total} overSize={overSize} overCount={overCount} busy={busy} />}
          </Presence>
          <Presence value={phase === "done" && result}>{(r) => <FileReports files={r.files} />}</Presence>
          <Presence value={phase === "error" && error && error.files?.length ? error : null}>
            {(e) => <FileReports files={e.files ?? []} />}
          </Presence>
        </div>

        {/* ----------------------------------------------------- right column -- */}
        <aside className="hidden lg:block">
          <div className="sticky top-[88px]">
            <Presence value={phase === "done" && result} gap="pb-4">{(r) => <MetricStrip result={r} />}</Presence>
            <ActionPanel {...props} total={total} canBuild={canBuild} />
          </div>
        </aside>
      </div>

      {/* Below `lg` the action panel folds into one docked bar. */}
      <div
        className="no-print fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t px-4 pb-3 pt-3 sm:bottom-0 sm:pb-[calc(12px+env(safe-area-inset-bottom))] lg:hidden"
        style={{
          background: "var(--panel)",
          boxShadow: "0 -6px 20px rgba(15,37,54,0.08)",
        }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <OptionsInline {...props} />
          </div>
          <PrimaryButton {...props} canBuild={canBuild} className="shrink-0" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Presence: blocks slide open and closed instead of popping in               */
/* -------------------------------------------------------------------------- */

/**
 * Renders `children(value)` while `value` is truthy, and animates its height
 * and opacity on the way in and out so everything below it glides down (or
 * back up) rather than jumping. The last truthy value is kept so the block
 * still has content to show while it closes.
 */
function Presence<T>({
  value,
  children,
  gap = "pb-5",
}: {
  value: T | null | undefined | false | "" | 0;
  children: (v: T) => ReactNode;
  gap?: string;
}) {
  const last = useRef<T | null>(null);
  if (value) last.current = value as T;
  const shown = !!value;
  // Present on first render means open straight away: only changes animate.
  const [open, setOpen] = useState(shown);

  useEffect(() => {
    if (shown === open) return;
    // Opening starts one frame after mount at the closed size, so it animates.
    const id = requestAnimationFrame(() => setOpen(shown));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  if (last.current === null) return null;
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transform: open ? "none" : "translateY(-6px)",
        transition:
          "grid-template-rows 0.5s var(--ease-premium), opacity 0.4s ease, transform 0.5s var(--ease-premium)",
      }}
      aria-hidden={!open}
    >
      <div className="-mx-2 min-h-0 overflow-hidden px-2">
        <div className={gap}>{children(last.current)}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dropzone                                                                   */
/* -------------------------------------------------------------------------- */

function Dropzone({
  onAddFiles,
  disabled,
  compact,
}: PrinterViewProps & { disabled: boolean; compact: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(list: FileList | null) {
    if (!list || !onAddFiles) return;
    onAddFiles(Array.from(list));
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) take(e.dataTransfer.files);
      }}
      className={cn(
        "panel flex flex-col items-center justify-center text-center transition-colors",
        compact
          ? "gap-2 px-4 py-3 sm:flex-row sm:justify-between sm:gap-3 sm:px-5 sm:py-6 sm:text-left"
          : "flex-1 gap-4 px-6 py-8 sm:py-16 lg:flex-none",
      )}
      style={{
        borderStyle: "dashed",
        borderWidth: 1.5,
        borderColor: over ? "var(--accent)" : "var(--border-strong)",
        background: over ? "var(--accent-soft)" : "var(--panel)",
      }}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      <div className={cn("flex items-center gap-4", compact ? "sm:flex-row" : "flex-col")}>
        <span
          className={cn("flex shrink-0 items-center justify-center rounded-2xl", compact ? "h-11 w-11" : "h-14 w-14")}
          style={{
            background: "linear-gradient(135deg, var(--accent-soft), rgba(34,211,238,0.14))",
            color: "var(--accent)",
          }}
        >
          <Upload className={compact ? "h-5 w-5" : "h-6 w-6"} />
        </span>
        <div>
          <p className={cn("font-semibold", compact ? "text-sm" : "text-base")}>
            {compact ? "Add more PDFs" : (
              <>
                <span className="hidden sm:inline">Drop PDFs here</span>
                <span className="sm:hidden">Add your PDFs</span>
              </>
            )}
          </p>
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => input.current?.click()}>
        <FileText className="h-4 w-4" />
        Choose PDFs
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File list                                                                  */
/* -------------------------------------------------------------------------- */

function FileList({
  files,
  total,
  overSize,
  overCount,
  busy,
  onRemove,
  onClear,
}: PrinterViewProps & { total: number; overSize: boolean; overCount: boolean; busy: boolean }) {
  return (
    <section className="panel overflow-hidden">
      <header
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ background: "var(--panel-2)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          Files
          <span
            className="rounded-full px-1.5 py-px text-[10.5px] tabular-nums"
            style={{ background: "var(--panel)", color: "var(--muted)" }}
          >
            {files.length}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span
            className="tabular-nums"
            style={{ color: overSize ? "var(--danger)" : "var(--muted)" }}
          >
            {formatSize(total)} of {formatSize(MAX_TOTAL_BYTES)}
          </span>
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="font-medium disabled:opacity-40"
            style={{ color: "var(--accent)" }}
          >
            Clear all
          </button>
        </div>
      </header>

      {overSize || overCount ? (
        <p className="px-4 py-2.5 text-[13px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {overCount
            ? `That is more than ${MAX_FILES} files. Remove a few, or run them in two batches.`
            : "These PDFs are too large for one run. Remove some and run them as two batches."}
        </p>
      ) : null}

      <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            >
              <FileText className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
            <span className="muted text-xs tabular-nums">{formatSize(f.size)}</span>
            <button
              type="button"
              onClick={() => onRemove?.(f.id)}
              disabled={busy}
              aria-label={`Remove ${f.name}`}
              className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--danger-soft)] disabled:opacity-40"
              style={{ color: "var(--muted)" }}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Action panel (desktop) + option toggles                                    */
/* -------------------------------------------------------------------------- */

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "var(--accent)" : "var(--border-strong)" }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]"
          style={{ left: checked ? 18 : 2, boxShadow: "var(--shadow-xs)" }}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
      </span>
    </label>
  );
}

function ActionPanel(props: PrinterViewProps & { total: number; canBuild: boolean }) {
  const { options, onOptions, total } = props;
  return (
    <div className="space-y-4">
      <section className="panel space-y-4 p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          Sheet options
        </h2>
        <Toggle
          checked={options.stamp}
          onChange={(stamp) => onOptions?.({ ...options, stamp })}
          label="Product stamp"
        />
        <Toggle
          checked={options.cutGuides}
          onChange={(cutGuides) => onOptions?.({ ...options, cutGuides })}
          label="Cut guides"
        />
      </section>

      <section className="panel space-y-3 p-5">
        <div className="flex items-center justify-between text-xs">
          <span className="muted font-medium">Data limit</span>
          <span className="muted tabular-nums">{formatSize(total)} of {formatSize(MAX_TOTAL_BYTES)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
          <div
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${Math.min(100, (total / MAX_TOTAL_BYTES) * 100)}%`,
              background: total > MAX_TOTAL_BYTES ? "var(--danger)" : "linear-gradient(90deg, var(--accent), var(--accent-2))",
            }}
          />
        </div>
        <PrimaryButton {...props} canBuild={props.canBuild} className="w-full" />
      </section>
    </div>
  );
}

function OptionsInline({ options, onOptions }: PrinterViewProps) {
  const chip = (on: boolean, label: string, flip: () => void) => (
    <button
      type="button"
      onClick={flip}
      className="rounded-full px-3 py-2 text-xs font-medium"
      style={{
        background: on ? "var(--accent-soft)" : "var(--panel-2)",
        color: on ? "#0b7fb0" : "var(--muted)",
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-2">
      {chip(options.stamp, "Stamp", () => onOptions?.({ ...options, stamp: !options.stamp }))}
      {chip(options.cutGuides, "Cut guides", () => onOptions?.({ ...options, cutGuides: !options.cutGuides }))}
    </div>
  );
}

function PrimaryButton({
  phase,
  result,
  canBuild,
  onBuild,
  onReset,
  className,
}: PrinterViewProps & { canBuild: boolean; className?: string }) {
  if (phase === "done" && result) {
    return (
      <button type="button" className={cn("btn btn-primary", className)} onClick={onReset}>
        <Printer className="h-4 w-4" />
        Start new batch
      </button>
    );
  }
  return (
    <button type="button" className={cn("btn btn-primary", className)} disabled={!canBuild} onClick={onBuild}>
      {phase === "processing" ? <Spinner size="1.1rem" color="#fff" /> : <Layers className="h-4 w-4" />}
      {phase === "processing" ? "Building…" : "Build label sheet"}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Result + error                                                             */
/* -------------------------------------------------------------------------- */

function MetricStrip({ result }: { result: RunResult }) {
  const cells: { label: string; value: number; tone?: string }[] = [
    { label: "Labels", value: result.labels },
    { label: "Sheets", value: result.sheets },
    { label: "Duplicates", value: result.duplicates.length, tone: result.duplicates.length ? "var(--warn)" : undefined },
    { label: "No stamp", value: result.unstamped, tone: result.unstamped ? "var(--warn)" : undefined },
  ];
  return (
    <div className="panel grid grid-cols-4 divide-x overflow-hidden" style={{ borderColor: "var(--border)" }}>
      {cells.map((c) => (
        <div key={c.label} className="flex items-baseline justify-center gap-1 px-1 py-2.5" style={{ borderColor: "var(--border)" }}>
          <span className="text-[15px] font-semibold tabular-nums" style={{ color: c.tone ?? "var(--text)" }}>
            {c.value}
          </span>
          <span className="muted whitespace-nowrap text-[11px]">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]"
      style={{
        background: warn ? "var(--warn-soft)" : "var(--accent-soft)",
        color: warn ? "#8a5a17" : "#0b7fb0",
      }}
    >
      {warn ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Tags className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ResultHead({ result }: { result: RunResult }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
          <CheckCircle2 className="h-4 w-4" />
        </span>
        <h2 className="text-base font-semibold">Your sheet is ready</h2>
        <a href={result.url} target="_blank" rel="noreferrer" className="btn btn-primary ml-auto">
          <ExternalLink className="h-4 w-4" />
          Open sheet
        </a>
      </div>

      {/* Desktop shows these in the right rail instead. */}
      <div className="lg:hidden">
        <MetricStrip result={result} />
      </div>
    </section>
  );
}

const hasWarnings = (r: RunResult) => r.duplicates.length > 0 || r.unstamped > 0 || r.framesRemoved > 0;

function Warnings({ result }: { result: RunResult }) {
  return (
    <div className="space-y-3">
      {result.duplicates.length > 0 ? (
        <Notice tone="warn">
          <b>Same order on more than one label:</b>{" "}
          <span className="break-words tabular-nums">{result.duplicates.join(", ")}</span>
        </Notice>
      ) : null}
      {result.unstamped > 0 ? (
        <Notice tone="warn">
          {result.unstamped} label{result.unstamped === 1 ? "" : "s"} printed without the product stamp: invoice not readable.
        </Notice>
      ) : null}
      {result.framesRemoved > 0 ? (
        <Notice tone="info">
          Black frame removed from {result.framesRemoved} label{result.framesRemoved === 1 ? "" : "s"}.
        </Notice>
      ) : null}
    </div>
  );
}

function FileReports({ files }: { files: RunFileReport[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,1fr)_70px_70px] gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-wider sm:grid" style={{ background: "var(--panel-2)", color: "var(--muted-2)", borderBottom: "1px solid var(--border)" }}>
        <span>File</span>
        <span className="text-right">Pages</span>
        <span className="text-right">Labels</span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
        {files.map((f, i) => {
          const note = skippedSummary(f);
          return (
            <li key={`${f.name}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_70px_70px]">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{f.name}</p>
                {note ? (
                  <p className="mt-0.5 text-xs" style={{ color: f.error ? "var(--danger)" : "var(--muted)" }}>
                    {note}
                  </p>
                ) : null}
              </div>
              <span className="muted hidden text-right text-sm tabular-nums sm:block">{f.pages}</span>
              <span className="text-right text-sm font-semibold tabular-nums">
                {f.labels}
                <span className="muted ml-1 text-xs font-normal sm:hidden">of {f.pages} pages</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ErrorHead({ error }: { error: { message: string; files?: RunFileReport[] } }) {
  return (
    <div
      className="flex items-start gap-3 rounded-2xl px-4 py-3.5"
      style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)" }}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="text-sm font-semibold">Could not build the sheet</p>
        <p className="mt-0.5 text-[13px]">{error.message}</p>
      </div>
    </div>
  );
}
