/**
 * The OMS is served under a path prefix (`/pom` on paribelle.in, via the
 * storefront's cross-zone rewrite). `basePath` in next.config.mjs teaches Next
 * about it, which covers `<Link>`, `redirect()`, `router.push()`, `next/image`
 * and `usePathname()`.
 *
 * What it cannot cover is a raw string. Anything that builds a URL by hand has
 * to put this prefix in front of it:
 *
 *  - `fetch()` against our own route handlers, which would otherwise 404
 *  - the `history.pushState` the orders cache uses to keep the URL in step,
 *    which would otherwise rewrite the address bar to a storefront path
 *  - the auth cookie paths, so an OMS session is not sent to the storefront
 *
 * The value comes from next.config.mjs, which sets NEXT_PUBLIC_BASE_PATH from
 * the same constant it feeds to `basePath`. That keeps the two from drifting
 * and means nothing has to be configured in Vercel for this to be right.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Prefix an app-absolute path ("/api/labels") so it survives the basePath.
 * Pass the path exactly as it appears in the app; the prefix is added here.
 */
export function withBasePath(path: string) {
  return `${BASE_PATH}${path}`;
}

/**
 * The prefix as a cookie `path`. Cookies need a non-empty path, so this falls
 * back to "/" when the app is served at the root (local dev, or a standalone
 * deployment with no prefix).
 */
export const COOKIE_PATH = BASE_PATH || "/";

/**
 * Strip the prefix off a `window.location.pathname`.
 *
 * `usePathname()` already returns the app-relative path, but the raw
 * `location.pathname` read in a `popstate` handler still carries the basePath.
 * This brings the two back into the same frame so they can be compared.
 */
export function stripBasePath(pathname: string) {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }
  return pathname;
}
