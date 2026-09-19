import { PageLoader } from "@/components/ui";

/**
 * Shown the instant a nav item is clicked, while the next screen's data loads
 * on the server. The header and everything around this stays put, so the app
 * feels switched at once instead of frozen on the old screen.
 */
export default function Loading() {
  return <PageLoader />;
}
