import React, { useEffect, useId, useState } from "react";
import css from "./client.css";
import logoDay from "./logo-day.png";
import logoNight from "./logo-night.png";
import { resultKind, ResultView } from "./result-view.jsx";
import resultCss from "./result-view.css";

const namespace = "qz-browser";
const messages = {
  en: {
    browser: "qz browser", title: "Browser operation", running: "Running", stopped: "Stopped",
    error: "Failed", done: "Completed", duration: "{seconds}s", result: "Result", trace: "Trace",
    script: "Script", details: "Browser operation details", inspect: "Inspect raw call", copy: "Copy content",
    copied: "Copied", copyFailed: "Could not copy", executing: "Running browser script…",
    stoppedTitle: "Execution stopped", stoppedDescription: "You can continue in this browser session.",
    errorDetails: "Error details", images: "Images", noTrace: "This script produced no trace.",
    preparing: "Generating script…", noScript: "No script available.", noResult: "No return value",
    article: "Article", axTree: "Page structure", metadata: "Details", characters: "{count} characters",
    links: "{count} links", nodes: "{count} nodes", truncated: "Partial tree",
    articleContinuation: "Continues at character {offset} of {total}.", showMore: "Show more · {count} remaining",
    expandNode: "Expand node", collapseNode: "Collapse node", copyCode: "Copy code", code: "Code",
    wrapCode: "Wrap lines", unwrapCode: "Unwrap lines", footnotes: "Footnotes",
  },
  zh: {
    browser: "轻舟浏览器", title: "浏览器操作", running: "执行中", stopped: "已停止",
    error: "未完成", done: "已完成", duration: "{seconds} 秒", result: "结果", trace: "Trace",
    script: "脚本", details: "浏览器调用详情", inspect: "查看原始调用", copy: "复制当前内容",
    copied: "已复制", copyFailed: "复制失败", executing: "正在执行浏览器脚本…",
    stoppedTitle: "本次执行已停止", stoppedDescription: "可以在当前浏览器会话中继续操作。",
    errorDetails: "错误详情", images: "图片", noTrace: "这次脚本没有输出 Trace。",
    preparing: "正在生成脚本…", noScript: "没有可显示的脚本。", noResult: "无返回值",
    article: "文章", axTree: "页面结构", metadata: "详细信息", characters: "{count} 字符",
    links: "{count} 个链接", nodes: "{count} 个节点", truncated: "部分结构",
    articleContinuation: "共 {total} 字符，可从位置 {offset} 继续读取。", showMore: "显示更多 · 剩余 {count} 行",
    expandNode: "展开节点", collapseNode: "收起节点", copyCode: "复制代码", code: "代码",
    wrapCode: "自动换行", unwrapCode: "取消换行", footnotes: "脚注",
  },
};

function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function Icon({ name, ...props }) {
  const paths = {
    chevron: "m6 9 6 6 6-6", check: "m5 12 4 4L19 6",
    copy: "M9 9h11v11H9zM4 15H3V3h12v1", external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
    alert: "M12 8v5m0 3h.01M10.3 3.8 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.8a2 2 0 0 0-3.4 0Z",
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={paths[name]} />
  </svg>;
}

function Logo() {
  return <>
    <img className="qzv-logo qzv-logo-day" src={logoDay} width="36" height="36" alt="" />
    <img className="qzv-logo qzv-logo-night" src={logoNight} width="36" height="36" alt="" />
  </>;
}

function Value({ value, t, depth = 0 }) {
  if (resultKind(value)) return <ResultView value={value} t={t}
    renderValue={item => <Value value={item} t={t} depth={depth + 1} />} />;
  if (value === null || value === undefined) {
    return <span className="qzv-muted">{value === null ? "null" : t("noResult")}</span>;
  }
  if (typeof value === "boolean") return <span className="qzv-boolean">{String(value)}</span>;
  if (typeof value === "string") {
    return /^https?:\/\/\S+$/.test(value)
      ? <a className="qzv-link" href={value} target="_blank" rel="noreferrer">{value}<Icon name="external" /></a>
      : <span className="qzv-string">{value}</span>;
  }
  if (Array.isArray(value) && value.length > 0 && value.length <= 12
    && value.every(item => typeof item === "string" && item.length < 60 && !item.includes("\n"))) {
    return <ul className="qzv-tags">{value.map((item, index) => <li key={index}>{item}</li>)}</ul>;
  }
  if (Array.isArray(value) && value.length > 0 && depth < 2) {
    return <ol className="qzv-list">{value.map((item, index) =>
      <li key={index}><Value value={item} t={t} depth={depth + 1} /></li>)}</ol>;
  }
  if (!Array.isArray(value) && typeof value === "object" && Object.keys(value).length > 0 && depth < 2) {
    return <dl className="qzv-fields">{Object.entries(value).map(([key, item]) =>
      <div className={item && typeof item === "object" ? "qzv-field qzv-field--block" : "qzv-field"}
        key={key}><dt>{key}</dt><dd><Value value={item} t={t} depth={depth + 1} /></dd></div>)}</dl>;
  }
  return <span className="qzv-string">{JSON.stringify(value, null, 2)}</span>;
}

function Images({ images, t, renderFactorySlot, loadImage }) {
  return <section className="qzv-images" aria-label={t("images")}>
    <div className="qzv-image-label">{t("images")} <span>{images.length}</span></div>
    <div className="qzv-image-grid">{images.map(({ attachment }, index) => <figure key={attachment.attachmentId || index}>
      {renderFactorySlot("conversation.images.content", {
        images: [{ attachment }], loadImage, align: "start", compact: false,
      })}
      <figcaption>{[attachment.width && attachment.height ? `${attachment.width} × ${attachment.height}` : "",
        attachment.mediaType?.replace(/^image\//, "").toUpperCase()].filter(Boolean).join(" · ")}</figcaption>
    </figure>)}</div>
  </section>;
}

function BrowserRow(props) {
  const { block, phase, t } = props;
  const args = parseJSON(block.call?.argsRaw ?? block.argsRaw ?? "") || {};
  const meta = block.meta?.kind === namespace ? block.meta : null;
  const output = (block.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
  const receipt = meta?.receipt || parseJSON(output);
  const result = receipt && Object.hasOwn(receipt, "result") ? receipt.result : output;
  const running = phase !== "result";
  const stopped = !running && (block.error?.code === "interrupted"
    || ["ABORTED", "INTERRUPTED"].includes(receipt?.result?.code));
  const failed = !running && !stopped && (block.isError || receipt?.ok === false);
  const state = running ? "running" : stopped ? "stopped" : failed ? "error" : "done";
  const title = args.title || t("title");
  const duration = meta?.durationMs ?? (block.callTime ? block.time - block.callTime : 0);
  const traces = Array.isArray(receipt?.trace) ? receipt.trace : [];
  const images = (block.content || []).filter(part => part.type === "image" && part.attachment)
    .map(part => ({ attachment: part.attachment }));
  const [tab, setTab] = useState("result");
  const [copyState, setCopyState] = useState("copy");
  const { expanded, toggle } = props.useDisclosure();
  const id = useId();
  const tabs = ["result", "trace", "script"];

  useEffect(() => {
    if (copyState === "copy") return;
    const timer = setTimeout(() => setCopyState("copy"), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    const text = tab === "script" ? args.code || "" : tab === "trace"
      ? traces.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n")
      : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    try {
      await navigator.clipboard.writeText(text ?? "");
      setCopyState("copied");
    } catch { setCopyState("copyFailed"); }
  }

  function switchTab(event) {
    const index = tabs.indexOf(tab);
    const next = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setTab(tabs[next]);
    event.currentTarget.querySelectorAll('[role="tab"]')[next].focus();
  }

  return <section className="qzv-card" data-qz-state={state} data-qz-call={props.callId}>
    <button type="button" className="qzv-header" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={toggle}>
      <span className="qzv-mark" title={t("browser")}><Logo /></span>
      <span className="qzv-heading" title={meta?.session?.title}><strong>{title}</strong></span>
      <span className="qzv-state">{state === "done" ? <Icon name="check" /> : <i />}{t(state)}</span>
      {!running && duration > 0 && <span className="qzv-duration">{t("duration", { seconds: (duration / 1000).toFixed(1) })}</span>}
      <Icon name="chevron" className={expanded ? "qzv-chevron is-open" : "qzv-chevron"} />
    </button>
    {running && <div className="qzv-progress" aria-label={t("executing")}><span /></div>}
    {expanded && <div id={`${id}-body`}>
      <div className="qzv-toolbar">
        <div className="qzv-tabs" role="tablist" aria-label={t("details")} onKeyDown={switchTab}>
          {tabs.map(name => <button type="button" key={name} id={`${id}-${name}`} role="tab"
            aria-selected={tab === name} aria-controls={`${id}-panel`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}>{t(name)}
            {name === "trace" && <span className="qzv-count">{traces.length}</span>}
          </button>)}
        </div>
        <span className="qzv-actions">
          {props.inspect && <button type="button" onClick={props.inspect} title={t("inspect")} aria-label={t("inspect")}><Icon name="external" /></button>}
          <button type="button" onClick={copy} title={t(copyState)} aria-label={t(copyState)}>
            <Icon name={copyState === "copied" ? "check" : "copy"} />
            {copyState !== "copy" && <span role="status">{t(copyState)}</span>}
          </button>
        </span>
      </div>
      <div className="qzv-panel" id={`${id}-panel`} data-qz-panel={tab} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
        {tab === "result" && (running
          ? <div className="qzv-wait"><span className="qzv-spinner" />{t("executing")}</div>
          : stopped ? <div className="qzv-notice"><strong>{t("stoppedTitle")}</strong><p>{t("stoppedDescription")}</p></div>
            : failed ? <div className="qzv-error">
              <div><Icon name="alert" /><strong>{receipt?.result?.code || block.error?.code || t("error")}</strong></div>
              <p>{receipt?.result?.message || block.error?.reason || output}</p>
              {receipt?.result?.details && <details><summary>{t("errorDetails")}</summary><pre>{JSON.stringify(receipt.result.details, null, 2)}</pre></details>}
            </div>
              : <>{images.length > 0 && <Images images={images} t={t}
                renderFactorySlot={props.renderFactorySlot} loadImage={props.loadImage} />}
                <Value value={result} t={t} /></>)}
        {tab === "trace" && (traces.length > 0
          ? <ol className="qzv-traces">{traces.map((line, index) => <li key={index}>
            <span className="qzv-trace-index">{String(index + 1).padStart(2, "0")}</span>
            <pre>{typeof line === "string" ? line : JSON.stringify(line, null, 2)}</pre>
          </li>)}</ol>
          : <div className="qzv-empty">{t("noTrace")}</div>)}
        {tab === "script" && <pre className="qzv-code"><code>{args.code || t(running ? "preparing" : "noScript")}</code></pre>}
      </div>
    </div>}
  </section>;
}

export const inject = ["slots", "locale"];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(namespace, messages));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.pluginCss = namespace;
    style.textContent = css + "\n" + resultCss;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
    name: "tool.call.toolview", key: "qz_browser", locale: namespace,
  }, BrowserRow));
}
