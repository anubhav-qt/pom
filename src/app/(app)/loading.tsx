import { CenteredSpinner } from "@/components/ui";

/**
 * Shown the instant a nav item is clicked, while the next screen's data loads
 * on the server. The header and everything around this stays put, so the app
 * feels switched at once instead of frozen on the old screen.
 */
export default function Loading() {
  return (
    // Negative margins cancel the page padding, so the white runs edge to edge.
    <div
      aria-busy="true"
      className="-mx-4 -mb-8 -mt-6 min-h-[calc(100dvh-57px)] bg-white sm:-mx-6"
    >
      <CenteredSpinner className="py-24" />
    </div>
  );
}
