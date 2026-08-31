/**
 * Wraps a sanitized HTML fragment (already stripped of scripts/handlers/
 * external resources server-side — see sanitize-html.ts) with just enough
 * page shell to look presentable in the sandboxed iframe: a CSS reset and
 * light/dark-aware base colors. The content itself is entirely the model's
 * design, not derived from any fixed card shape.
 */
export function wrapHtmlFragment(fragmentHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: Canvas; color: CanvasText; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 8px; }
  img { max-width: 100%; }
</style>
</head>
<body>
${fragmentHtml}
</body>
</html>`;
}
