import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitizes model-authored HTML before it's ever stored in a response or
 * rendered. The model is free to design whatever layout the question calls
 * for, but it never gets script execution or a way to phone home: no
 * <script>, no event handlers (DOMPurify strips these by default), no
 * frames/forms/embeds, and no external resources — only inline styles and
 * the data already in the fragment.
 */
export function sanitizeAssistantHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "link", "meta", "style"],
    FORBID_ATTR: ["style-src", "srcset", "poster"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  }).toString();
}
