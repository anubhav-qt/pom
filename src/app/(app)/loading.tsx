import { Spinner } from "@/components/ui";

/**
 * Shown the instant a nav item is clicked, while the next screen's data loads
 * on the server. The header and everything around this stays put, so the app
 * feels switched at once instead of frozen on the old screen.
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" style={{ animation: "rise-in 0.25s var(--ease-premium)" }}>
      <div className="flex items-center justify-center gap-2.5 py-10" style={{ color: "var(--muted)" }}>
        <Spinner size="2rem" />
        <span className="text-sm font-medium">Loading…</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel h-20 animate-pulse" style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <div className="panel h-64 animate-pulse" />
    </div>
  );
}
