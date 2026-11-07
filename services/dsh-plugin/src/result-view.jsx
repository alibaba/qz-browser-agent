import React, { useEffect, useMemo, useState } from "react";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";

const articleModes = new Set(["auto", "selection", "article", "target", "body"]);
const articleFields = new Set(["title", "url", "byline", "siteName", "publishedTime", "text",
  "totalChars", "returnedChars", "hasMore", "nextOffset", "linkCount"]);
const axFields = new Set(["title", "url", "snapshot", "scope", "nodeCount", "outlineTruncated"]);

/** Recognize complete public observations, including when a script nests them in its return value. */
export function resultKind(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.text === "string" && typeof value.url === "string"
    && articleModes.has(value.mode) && Number.isFinite(value.totalChars)) return "article";
  if (typeof value.snapshot === "string" && Number.isFinite(value.nodeCount)
    && ["full", "viewport"].includes(value.scope)) return "ax";
  return null;
}

function Source({ url }) {
  if (!url) return null;
  let href;
  try { const parsed = new URL(url); if (["http:", "https:"].includes(parsed.protocol)) href = parsed.href; } catch {}
  return href ? <a className="qzv-rich-source" href={href} target="_blank" rel="noopener noreferrer">{url}</a>
    : <span className="qzv-rich-source">{url}</span>;
}

function ExtraFields({ value, consumed, t, renderValue }) {
  const extra = Object.fromEntries(Object.entries(value).filter(([key, item]) => !consumed.has(key)
    && item !== undefined && item !== null && !(Array.isArray(item) && !item.length)));
  return Object.keys(extra).length > 0 && <details className="qzv-rich-extra">
    <summary>{t("metadata")}</summary>{renderValue(extra)}
  </details>;
}

function Article({ value, t, renderValue }) {
  const labels = useMemo(() => ({
    code: { copyLabel: t("copyCode"), copiedLabel: t("copied"),
      toolbarLabels: { codeLabel: t("code"), wrapLabel: t("wrapCode"), unwrapLabel: t("unwrapCode") } },
    footnotes: t("footnotes"),
  }), [t]);
  const attribution = [value.siteName, value.byline, value.publishedTime].filter(Boolean);
  return <article className="qzv-article" data-qz-result="article">
    <header className="qzv-rich-head">
      <h3>{value.title || t("article")}</h3><Source url={value.url} />
      <div className="qzv-rich-meta">
        {attribution.map((item, index) => <span key={index}>{item}</span>)}
        <span>{t("characters", { count: value.returnedChars ?? value.text.length })}</span>
        {value.linkCount > 0 && <span>{t("links", { count: value.linkCount })}</span>}
      </div>
    </header>
    <div className="qzv-article-body">
      <MarkdownText text={value.text} streaming={false} variant="compact" labels={labels} />
    </div>
    {value.hasMore && <div className="qzv-rich-foot">{t("articleContinuation", { offset: value.nextOffset, total: value.totalChars })}</div>}
    <ExtraFields value={value} consumed={articleFields} t={t} renderValue={renderValue} />
  </article>;
}

/** Snapshot indentation is produced by qz; retain every row and its text, only separate its target and role for display. */
function snapshotRows(snapshot) {
  const rows = snapshot.split(/\r?\n/).filter(line => line.trim()).map((raw, index) => {
    const depth = raw.length - raw.trimStart().length;
    let text = raw.trim();
    const targetMatch = /^target=("(?:\\.|[^"\\])*"|\S+)\s*/.exec(text);
    let target = targetMatch?.[1] || "";
    if (target.startsWith('"')) { try { target = JSON.parse(target); } catch {} }
    if (targetMatch) text = text.slice(targetMatch[0].length);
    const roleMatch = /^((?:index=\d+\s+)?)([A-Za-z][A-Za-z0-9]*)(?=\s|$)/.exec(text);
    return { index, depth, target, role: roleMatch?.[2] || "", text: roleMatch ? `${roleMatch[1]}${text.slice(roleMatch[0].length).trimStart()}`.trim() : text };
  });
  return rows.map((row, index) => ({ ...row, children: (rows[index + 1]?.depth ?? -1) > row.depth }));
}

function AxTree({ value, t, renderValue }) {
  const rows = useMemo(() => snapshotRows(value.snapshot), [value.snapshot]);
  const [limit, setLimit] = useState(80);
  const [collapsed, setCollapsed] = useState(() => new Set());
  useEffect(() => { setLimit(80); setCollapsed(new Set()); }, [value.snapshot]);
  const visible = [];
  let hiddenDepth = null;
  for (const row of rows) {
    if (hiddenDepth !== null && row.depth > hiddenDepth) continue;
    hiddenDepth = null;
    visible.push(row);
    if (collapsed.has(row.index)) hiddenDepth = row.depth;
  }
  function toggle(index) {
    setCollapsed(previous => { const next = new Set(previous); next.has(index) ? next.delete(index) : next.add(index); return next; });
  }
  return <section className="qzv-ax" data-qz-result="ax">
    <header className="qzv-rich-head">
      <h3>{value.title || t("axTree")}</h3><Source url={value.url} />
      <div className="qzv-rich-meta">
        <span>{t("axTree")}</span><span>{value.scope}</span><span>{t("nodes", { count: value.nodeCount })}</span>
        {value.outlineTruncated && <span>{t("truncated")}</span>}
      </div>
    </header>
    <div className="qzv-ax-body">
      {visible.slice(0, limit).map(row => <div className="qzv-ax-row" key={row.index} style={{ "--qzv-depth": Math.min(row.depth, 16) }}>
        {row.children ? <button type="button" className="qzv-ax-toggle" onClick={() => toggle(row.index)}
          aria-expanded={!collapsed.has(row.index)} aria-label={t(collapsed.has(row.index) ? "expandNode" : "collapseNode")}>
          {collapsed.has(row.index) ? "▸" : "▾"}
        </button> : <span className="qzv-ax-spacer" />}
        <span className="qzv-ax-content">{row.role && <span className="qzv-ax-role">{row.role}</span>}
          {row.text && <span className="qzv-ax-text">{row.text}</span>}
          {row.target && <code className="qzv-ax-target">{row.target}</code>}
        </span>
      </div>)}
    </div>
    {limit < visible.length && <button type="button" className="qzv-rich-more" onClick={() => setLimit(previous => previous + 80)}>
      {t("showMore", { count: visible.length - limit })}
    </button>}
    <ExtraFields value={value} consumed={axFields} t={t} renderValue={renderValue} />
  </section>;
}

export function ResultView({ value, t, renderValue }) {
  return resultKind(value) === "article" ? <Article value={value} t={t} renderValue={renderValue} />
    : resultKind(value) === "ax" ? <AxTree value={value} t={t} renderValue={renderValue} /> : null;
}
