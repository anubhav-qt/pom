"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/utils";

import { RANGE_PRESETS, type RangePreset } from "./range";

const LABELS: Record<RangePreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function RangePicker({ active }: { active: RangePreset }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function select(range: RangePreset) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("range", range);
    startTransition(() => router.push(`/dashboard?${next.toString()}`));
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full border p-1"
      style={{ borderColor: "var(--border)", background: "var(--panel)", opacity: pending ? 0.6 : 1 }}
    >
      {RANGE_PRESETS.map((r) => (
        <button
          key={r}
          onClick={() => select(r)}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            active === r ? "text-white" : "muted hover:text-[var(--text)]",
          )}
          style={
            active === r
              ? { background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }
              : undefined
          }
        >
          {LABELS[r]}
        </button>
      ))}
    </div>
  );
}
