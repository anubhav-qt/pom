"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { memo, useState, type ReactNode } from "react";

import { BASE_PATH } from "@/lib/base-path";

/**
 * Seelie's replies, Markdown to React elements. Its own small parser, so a reply
 * can never put HTML on the page: every piece becomes an element React escapes.
 *
 * Covers what the model writes: headings, paragraphs, lists (nested, numbered,
 * tasks), fenced code, GFM tables, quotes, rules; bold, italic, strikethrough,
 * inline code, links and bare URLs. Links go to http(s), mail, or the OMS itself.
 */

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task: boolean | null; blocks: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function startsBlock(line: string, next: string | undefined) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes("|") && next !== undefined && TABLE_RULE.test(next));
}

function cells(row: string) {
  const out: string[] = [];
  let cur = "";
  let code = false;
  const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        body.push(lines[i++].replace(QUOTE, ""));
      }
      blocks.push({ t: "quote", blocks: parse(body.join("\n")) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      blocks.push({ t: "table", align, head, rows });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const items: { task: boolean | null; blocks: Block[] }[] = [];
      let start = ordered ? parseInt(item[2], 10) : 1;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
        if (items.length === 0 && ordered) start = parseInt(m[2], 10);
        const body = [m[3]];
        i++;
        // The item's own lines: anything indented past its marker, and blank lines between them.
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const nextIndent = lines[i + 1]?.match(/^\s*/)?.[0].length ?? 0;
            if (i + 1 < lines.length && lines[i + 1].trim() && nextIndent > indent) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const lead = l.match(/^\s*/)?.[0].length ?? 0;
          if (lead > indent) body.push(l);
          else if (!ITEM.test(l) && !startsBlock(l, lines[i + 1])) body.push(l);
          else break;
          i++;
        }
        const task = /^\[( |x|X)\]\s+/.exec(body[0]);
        if (task) body[0] = body[0].slice(task[0].length);
        items.push({ task: task ? task[1] !== " " : null, blocks: parse(dedent(body).join("\n")) });
        // A blank line, then another item of this list: still the same list.
        while (i < lines.length && !lines[i].trim() && ITEM.exec(lines[i + 1] ?? "")?.[1].length === indent) i++;
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines[i], lines[i + 1]))) body.push(lines[i++].trim());
    blocks.push({ t: "para", text: body.join("\n") });
  }
  return blocks;
}

function dedent(lines: string[]) {
  const rest = lines.slice(1).filter((l) => l.trim());
  const min = rest.length ? Math.min(...rest.map((l) => l.match(/^\s*/)?.[0].length ?? 0)) : 0;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(min))];
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                     */
/* -------------------------------------------------------------------------- */

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([\s\S]*?[^\s\\])\*|(?<![\w\\])_(?!\s)([\s\S]*?[^\s\\])_(?!\w)|\\([\\`*_{}[\]()#+\-.!|~>])|(\n)/g;

/** Where a link may go; anything else stays plain text. */
function safeHref(raw: string): { href: string; internal: boolean } | null {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return { href: url, internal: false };
  if (/^www\./i.test(url)) return { href: `https://${url}`, internal: false };
  if (url.startsWith("/") && !url.startsWith("//")) {
    // Links into the OMS go through Next, which adds the base path itself.
    const path = BASE_PATH && (url === BASE_PATH || url.startsWith(`${BASE_PATH}/`)) ? url.slice(BASE_PATH.length) || "/" : url;
    return { href: path, internal: true };
  }
  return null;
}

function A({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  const className = "font-medium underline decoration-[var(--accent-ring)] underline-offset-2 hover:decoration-[var(--accent)]";
  if (safe.internal) {
    return (
      <Link href={safe.href} className={className} style={{ color: "var(--accent-ink)" }}>
        {children}
      </Link>
    );
  }
  return (
    <a href={safe.href} target="_blank" rel="noopener noreferrer" className={className} style={{ color: "var(--accent-ink)" }}>
      {children}
    </a>
  );
}

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  // A fresh regex per call: the bold and link branches call this again mid-loop.
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const k = `${key}.${n++}`;
    if (m[1]) {
      out.push(
        <code key={k} className="rounded-md px-1 py-px font-mono text-[0.86em]" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}>
          {m[2].replace(/^ (.*) $/, "$1")}
        </code>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <A key={k} href={m[4]}>
          {inline(m[3], k)}
        </A>,
      );
    } else if (m[5] || m[6]) {
      const url = m[5] ?? m[6];
      out.push(
        <A key={k} href={url}>
          <span className="break-all">{url.replace(/^mailto:/, "")}</span>
        </A>,
      );
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(
        <strong key={k} className="font-semibold">
          {inline(m[7] ?? m[8], k)}
        </strong>,
      );
    } else if (m[9] !== undefined) {
      out.push(
        <del key={k} className="opacity-70">
          {inline(m[9], k)}
        </del>,
      );
    } else if (m[10] !== undefined || m[11] !== undefined) {
      out.push(<em key={k}>{inline(m[10] ?? m[11], k)}</em>);
    } else if (m[12]) {
      out.push(m[12]);
    } else if (m[13]) {
      out.push(<br key={k} />);
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="surface-2 group relative overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-1.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
        <span className="font-mono">{lang || " "}</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--tint-hover)]"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 pb-3 pt-1 font-mono text-[12.5px] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const HEADING_CLASS = ["", "text-lg font-semibold", "text-base font-semibold", "text-[15px] font-semibold", "text-sm font-semibold", "text-sm font-semibold", "text-sm font-medium muted"];

function render(blocks: Block[], key = "b"): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "heading": {
        const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
        return (
          <Tag key={k} className={`${HEADING_CLASS[b.level]} pt-1 tracking-tight`}>
            {inline(b.text, k)}
          </Tag>
        );
      }
      case "para":
        return <p key={k}>{inline(b.text, k)}</p>;
      case "code":
        return <CodeBlock key={k} lang={b.lang} text={b.text} />;
      case "hr":
        return <hr key={k} style={{ borderColor: "var(--border)" }} />;
      case "quote":
        return (
          <blockquote key={k} className="space-y-2 border-l-2 pl-3" style={{ borderColor: "var(--border-strong)", color: "var(--muted)" }}>
            {render(b.blocks, k)}
          </blockquote>
        );
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={k} start={b.ordered && b.start !== 1 ? b.start : undefined} className={`space-y-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"} marker:text-[var(--muted-2)]`}>
            {b.items.map((item, j) => (
              <li key={j} className={`space-y-1.5 pl-0.5 ${item.task !== null ? "list-none -ml-5" : ""}`}>
                {item.task !== null ? (
                  <span className="mr-1.5 inline-block align-[-2px]">
                    <span className="ui-checkbox pointer-events-none" data-checked={item.task} style={{ ["--checkbox-diameter" as string]: "14px" }} />
                  </span>
                ) : null}
                {item.blocks.length === 1 && item.blocks[0].t === "para" ? inline(item.blocks[0].text, `${k}.${j}`) : render(item.blocks, `${k}.${j}`)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={k} className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--border)" }}>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {b.head.map((h, j) => (
                    <th
                      key={j}
                      className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide"
                      style={{ background: "var(--panel-2)", color: "var(--muted)", borderBottom: "1px solid var(--border)", textAlign: b.align[j] ?? "left" }}
                    >
                      {inline(h, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r} className="hover:bg-[var(--accent-soft)]">
                    {b.head.map((_, j) => (
                      <td
                        key={j}
                        className="px-3 py-2 align-top"
                        style={{ borderTop: r ? "1px solid var(--border)" : undefined, textAlign: b.align[j] ?? "left", fontVariantNumeric: "tabular-nums" }}
                      >
                        {inline(row[j] ?? "", `${k}.${r}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`space-y-3 break-words text-sm leading-relaxed ${className ?? ""}`}>{render(parse(text))}</div>;
});
