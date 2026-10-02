"use client";

import { cn } from "@/lib/utils";

/** The app's on/off switch with its label (and a hint under it), shared by the PDF printer, Reels and Seelie. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cn("flex items-start gap-3", disabled ? "opacity-50" : "cursor-pointer", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "var(--accent)" : "var(--border-strong)" }}
      >
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]" style={{ left: checked ? 18 : 2, boxShadow: "var(--shadow-xs)" }} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="muted block text-xs">{hint}</span> : null}
      </span>
    </label>
  );
}
