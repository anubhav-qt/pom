"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The app's one toggle: the List / Collection / Planner switch on Orders,
 * lifted out so every other "pick one of a few" control looks and behaves the
 * same instead of each screen drawing its own.
 */
export interface SegmentedItem<T extends string> {
  key: T;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

/**
 * The raised pill behind a toggle's chosen item, gliding to each new choice
 * (`.seg-thumb` in globals.css). Put `ref` on the track (which must be
 * `relative`), `data-active` on the items, and render `thumb` inside the track.
 *
 * Until it has measured (the server's HTML, the first paint) `ready` is false,
 * and the chosen item should paint its own background so nothing flickers.
 */
export function useSlidingThumb<E extends HTMLElement = HTMLDivElement>(active: string | null) {
  const ref = useRef<E>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; glide: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (!el) {
      setBox(null);
      return;
    }
    const place = () =>
      setBox((prev) => ({
        x: el.offsetLeft,
        y: el.offsetTop,
        w: el.offsetWidth,
        h: el.offsetHeight,
        // The first placement jumps straight there; only later moves glide.
        glide: prev !== null,
      }));
    place();
    // Any item resizing (a count arriving, the web font swapping in) can move
    // the chosen one, so watch them all, not just it.
    const ro = new ResizeObserver(place);
    for (const child of Array.from(ref.current?.children ?? [])) ro.observe(child);
    let live = true;
    document.fonts?.ready.then(() => live && place());
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [active]);

  const thumb = box ? (
    <span
      aria-hidden
      className="seg-thumb"
      style={{
        width: box.w,
        height: box.h,
        transform: `translate(${box.x}px, ${box.y}px)`,
        ...(box.glide ? {} : { transition: "none" }),
      }}
    />
  ) : null;

  return { ref, thumb, ready: box !== null };
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Read out by screen readers. */
  label: string;
  className?: string;
}) {
  const { ref, thumb, ready } = useSlidingThumb(value);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn("seg relative inline-flex max-w-full overflow-x-auto rounded-[10px] p-[3px]", className)}
      style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
    >
      {thumb}
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-pressed={active}
            data-active={active}
            className={cn(
              "seg-item inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 py-1.5 text-xs font-medium",
              active ? "font-semibold" : "muted hover:text-[var(--text)]",
            )}
            style={
              active
                ? { color: "var(--text)", ...(ready ? {} : { background: "var(--panel)", boxShadow: "var(--shadow-xs)" }) }
                : undefined
            }
          >
            {t.icon}
            {t.label}
            {t.count !== undefined ? <span className="tabular-nums opacity-70">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
