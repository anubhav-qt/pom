"use client";

import { Monitor, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/base-path";
import { cn } from "@/lib/utils";

import { DEMO_STATES, type DemoState } from "./fixtures";

type Device = "desktop" | "mobile";

// Real CSS-pixel sizes the iframes render at, so Tailwind's breakpoints fire as
// they would on a real screen. A 24" 1080p monitor is the target: the frame is
// then scaled down to whatever room the stage has.
const SIZES: Record<Device, { w: number; h: number }> = {
  desktop: { w: 1440, h: 900 },
  mobile: { w: 390, h: 844 },
};

export function DemoStage() {
  const [device, setDevice] = useState<Device>("desktop");
  const [state, setState] = useState<DemoState>("files");
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.8);
  const frame = useRef<HTMLIFrameElement>(null);
  // The frame loads once per device; later state changes are sent to it, so the
  // real open/close animations play.
  const first = useRef(state);

  const { w, h } = SIZES[device];

  useEffect(() => {
    function fit() {
      const el = box.current;
      if (!el) return;
      const availW = el.clientWidth;
      // Leave room for the header bar, the controls above and some breathing space.
      const availH = window.innerHeight - el.getBoundingClientRect().top - 24;
      setScale(Math.min(1, availW / w, availH / h));
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [w, h]);

  const src = withBasePath(`/pdf-printer/demo/frame?state=${first.current}`);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ demoState: state }, window.location.origin);
  }, [state]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">PDF printer · design preview</h1>
          <p className="muted mt-0.5 text-sm">
            {w} × {h} shown at {Math.round(scale * 100)}%. Every state is a live render of the real screen.
          </p>
        </div>
        <div className="inline-flex rounded-[10px] p-[3px]" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-xs)" }}>
          {(["desktop", "mobile"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDevice(d)}
              className={cn("inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-medium capitalize transition-colors", device !== d && "muted")}
              style={device === d ? { background: "var(--accent-soft)", color: "#0b7fb0" } : undefined}
            >
              {d === "desktop" ? <Monitor className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {DEMO_STATES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setState(s.id)}
            className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
            style={
              state === s.id
                ? { background: "var(--accent-soft)", color: "#0b7fb0" }
                : { background: "var(--panel)", color: "var(--muted)", border: "1px solid var(--border)" }
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <div ref={box} className="flex justify-center">
        <div style={{ width: w * scale, height: h * scale }}>
          <div
            className={cn("overflow-hidden", device === "mobile" ? "rounded-[36px] border-[8px]" : "rounded-xl border")}
            style={{
              width: w,
              height: h,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              borderColor: device === "mobile" ? "#0f2536" : "var(--border-strong)",
              boxShadow: "var(--shadow-md)",
              background: "var(--bg)",
              boxSizing: "border-box",
            }}
          >
            <iframe ref={frame} key={device} src={src} title={`${device} preview`} onLoad={() => frame.current?.contentWindow?.postMessage({ demoState: state }, window.location.origin)} className="h-full w-full border-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
