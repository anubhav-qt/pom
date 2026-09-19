"use client";

import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

/**
 * One tap target + its anchored popover menu — the app's one dropdown
 * pattern, shared by the mobile Orders breadcrumb (category/sub-status) and
 * the mobile header's screen switcher, so every "tap text, pick from a small
 * list" interaction in the app looks and behaves identically.
 */
export function DropdownMenu({
  trigger,
  options,
  activeId,
  onSelect,
  align = "left",
  side = "down",
  className,
}: {
  trigger: React.ReactNode;
  options: DropdownOption[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Which edge the popover hangs from — "right" for a trigger near the
   *  screen's right edge, so the menu opens inward instead of off-screen. */
  align?: "left" | "right";
  /** "up" for a trigger docked to the bottom of the screen (the mobile nav). */
  side?: "down" | "up";
  /** Extra classes for the wrapper, e.g. `flex-1` to share a bar's width. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className={className ?? "relative shrink-0"} ref={ref} style={className ? { position: "relative" } : undefined}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className ? "w-full" : undefined}
      >
        {trigger}
      </button>

      {open ? (
        <div
          role="menu"
          className={`panel absolute z-20 w-52 p-1.5 ${side === "up" ? "bottom-full mb-2 origin-bottom" : "top-full mt-2 origin-top"}`}
          style={{
            animation: "rise-in 0.15s var(--ease-premium)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
          }}
        >
          {options.map((o) => {
            const active = o.id === activeId;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                disabled={o.disabled}
                onClick={() => {
                  if (o.disabled) return;
                  onSelect(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-default"
                style={{
                  background: active ? "var(--accent-soft)" : undefined,
                  color: o.disabled ? "var(--muted-2)" : active ? "#0b7fb0" : "var(--text)",
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span>{o.label}</span>
                {o.count !== undefined ? (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums"
                    style={{
                      background: active ? "var(--accent-soft)" : "var(--panel-2)",
                      color: active ? "#0b7fb0" : "var(--muted)",
                    }}
                  >
                    {o.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
