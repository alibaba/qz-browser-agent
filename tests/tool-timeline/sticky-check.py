#!/usr/bin/env python3
from contextlib import contextmanager
from pathlib import Path
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import serve_repository


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_close(actual, expected, message, tolerance=2.0):
    if abs(actual - expected) > tolerance:
        raise AssertionError(f"{message}: expected {expected:.2f}, got {actual:.2f}")


@contextmanager
def serve_repo():
    with serve_repository() as base_url:
        yield f"{base_url}/extension/sidepanel/sidepanel.html"


CHROME_MOCK = """
(() => {
  const listeners = { message: [], disconnect: [], changed: [] };
  const storage = { qz_data_consent: { version: 1, acceptedAt: 1 } };
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const emit = (event) => listeners.message.slice().forEach(fn => fn(event));
  const storageGet = async (keys) => {
    if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
    if (keys && typeof keys === 'object') {
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(storage[key] ?? fallback)]));
    }
    return clone(storage);
  };
  const respond = (msg, payload = {}) => {
    if (!msg?.requestId) return;
    setTimeout(() => emit({ requestId: msg.requestId, ...payload }), 0);
  };
  const port = {
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
    postMessage(msg) {
      if (!msg) return;
      if (msg.type === 'get_config') {
        setTimeout(() => emit({
          type: 'config',
          config: { provider: '', model: '', apiKey: '', modelProvider: '' },
          presets: [],
        }), 0);
        respond(msg, {
          type: 'config',
          config: { provider: '', model: '', apiKey: '', modelProvider: '' },
          presets: [],
        });
        return;
      }
      if (msg.type === 'get_messages') {
        setTimeout(() => emit({ type: 'messages', history: [], sessionId: msg.sessionId }), 0);
        respond(msg, { type: 'messages', history: [], sessionId: msg.sessionId });
        return;
      }
      if (msg.type === 'list_plugin_contributions') {
        respond(msg, { plugins: [], diagnostics: [], version: 1 });
        return;
      }
      if (msg.type === 'list_update_notices' || msg.type === 'check_updates') {
        respond(msg, { notices: [] });
        return;
      }
      if (msg.type === 'list_sessions') {
        respond(msg, { sessions: [] });
        return;
      }
      if (msg.type === 'create_ui_session') {
        respond(msg, { session: { id: 'sticky-session', title: 'sticky test', parentSessionId: '0' } });
        return;
      }
      if (msg.type === 'get_state') {
        respond(msg, { type: 'state', status: 'idle', sessionId: msg.sessionId });
        return;
      }
      respond(msg, {});
    },
  };
  window.__emitPortMessage = emit;
  window.chrome = {
    runtime: {
      connect() { return port; },
      getURL(path) { return '/extension/' + path; },
      async sendMessage() { return {}; },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get: storageGet,
        async set(values) { Object.assign(storage, clone(values)); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
      onChanged: { addListener(fn) { listeners.changed.push(fn); } },
    },
    downloads: { async download() { return 1; }, async search() { return []; }, open() {}, show() {} },
    tabs: { async query() { return []; }, async create() { return {}; } },
    desktopCapture: { chooseDesktopMedia(_sources, callback) { callback && callback('', {}); } },
  };
})();
"""


FIXTURE_JS = """
() => {
  const messages = document.querySelector('#messages');
  if (!messages) throw new Error('missing #messages');

  if (!messages.dataset.stickyHarnessInstalled) {
    messages.dataset.stickyHarnessInstalled = 'true';
    messages.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const chip = target?.closest('.tool-timeline-step, .tool-family-row, .tool-family-batch');
      if (chip && messages.contains(chip)) {
        event.preventDefault();
        event.stopPropagation();
        chip.dataset.clicked = String(Number(chip.dataset.clicked || '0') + 1);
        messages.dataset.lastStickyChip = chip.textContent.trim().replace(/\\s+/g, ' ');
        chip.classList.add('active');
        messages.scrollTop += 36;
        return;
      }
      const trigger = target?.closest('.tool-summary, .thinking-group-summary, .tool-event-collapse-btn, .tool-timeline-collapse-btn');
      if (!trigger || !messages.contains(trigger)) return;
      const card = trigger.closest('.msg-tool, .msg-tool-timeline, .msg-thinking-group');
      if (!card) return;
      const isFooterCollapse = trigger.matches('.tool-event-collapse-btn, .tool-timeline-collapse-btn');
      const expandedClass = card.classList.contains('msg-thinking-group')
        ? 'thinking-group-expanded'
        : card.classList.contains('msg-tool-timeline')
          ? 'tool-timeline-expanded'
          : 'tool-expanded';
      const nextExpanded = isFooterCollapse ? false : !card.classList.contains(expandedClass);
      card.classList.toggle(expandedClass, nextExpanded);
      const summary = card.querySelector(':scope > .tool-summary, :scope > .thinking-group-summary');
      const details = card.querySelector(':scope > .tool-details, :scope > .tool-timeline-details, :scope > .thinking-group-details');
      summary?.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      details?.classList.toggle('hidden', !nextExpanded);
      const caret = summary?.querySelector('.tool-caret, .thinking-caret');
      if (caret) caret.textContent = nextExpanded ? '▾' : '▸';
    });
  }

  const filler = (label, lines = 34) => Array.from({ length: lines }, (_, index) =>
    `<p class="sticky-line">${label} detail line ${index + 1} wraps enough content to keep the card taller than the viewport.</p>`
  ).join('');

  messages.innerHTML = `
    <div class="sticky-spacer sticky-spacer-top">上方对话占位</div>
    <div class="msg msg-tool tool-expanded" data-sticky-kind="single">
      <button type="button" class="tool-summary" aria-expanded="true">
        <span class="dot"></span>
        <span class="tool-name">全网热点趋势聚合 · 纽约时报新闻</span>
        <span class="tool-args-preview">(timeout=15000)</span>
        <span class="tool-caret">▾</span>
      </button>
      <div class="tool-details">
        <strong>错误</strong>
        <p class="error">工具执行失败</p>
        <button type="button" class="tool-event-collapse-btn">收起</button>
        ${filler('single', 30)}
      </div>
    </div>
    <div class="sticky-spacer">中段对话占位</div>
    <div class="msg msg-tool-timeline tool-timeline-expanded" data-sticky-kind="timeline">
      <button type="button" class="tool-summary tool-timeline-summary" aria-expanded="true">
        <span class="dot"></span>
        <span class="tool-name">工具执行概览</span>
        <span class="tool-args-preview">35 步 · 到达页面 17 · 采集信息 17 · 生成产物 1</span>
        <span class="tool-caret">▾</span>
	      </button>
	      <div class="tool-timeline-details">
	        <div class="tool-timeline-nav-area">
	          <div class="tool-family-tabs">
	            <button type="button" class="tool-family-row" data-tool-timeline-index="0">到达页面 17</button>
	            <button type="button" class="tool-family-row" data-tool-timeline-index="1">采集信息 17</button>
	          </div>
	        </div>
	        <button type="button" class="tool-timeline-collapse-btn">收起</button>
        ${filler('timeline', 36)}
      </div>
    </div>
    <div class="sticky-spacer">思考前占位</div>
    <div class="msg msg-thinking-group thinking-group-expanded" data-sticky-kind="thinking">
      <button type="button" class="thinking-group-summary" aria-expanded="true">
        <span class="thinking-dot"></span>
        <span class="thinking-group-title">思考完成</span>
        <span class="thinking-group-preview"><span class="thinking-group-preview-track"><span class="thinking-group-preview-text">最近思考 preview should hide while expanded</span></span></span>
        <span class="thinking-caret">▾</span>
      </button>
      <div class="thinking-group-details">
        <div class="thinking-group-slot-head">最近思考</div>
        ${filler('thinking', 28)}
      </div>
    </div>
    <div class="sticky-spacer sticky-spacer-bottom">底部对话占位</div>
  `;

  const style = document.createElement('style');
  style.id = 'sticky-test-fixture-style';
  style.textContent = `
    #messages .sticky-spacer {
      height: 220px;
      color: var(--text-muted);
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }
    #messages .sticky-spacer-top { height: 260px; }
    #messages .sticky-spacer-bottom { height: 1400px; }
    #messages .sticky-line { margin: 0 0 18px; color: var(--text-secondary); }
    #messages .msg-tool,
    #messages .msg-tool-timeline,
    #messages .msg-thinking-group { margin-bottom: 18px; }
	    #messages .msg-tool,
	    #messages .msg-tool *,
	    #messages .msg-tool-timeline,
	    #messages .msg-tool-timeline *,
	    #messages .msg-thinking-group,
	    #messages .msg-thinking-group * {
	      animation: none !important;
	      transition: none !important;
	    }
  `;
  document.querySelector('#sticky-test-fixture-style')?.remove();
  document.head.appendChild(style);
  messages.scrollTop = 0;
}
"""


HELPERS_JS = """
() => {
	  window.__stickyTest = {
	    messages() { return document.querySelector('#messages'); },
	    card(kind) { return document.querySelector(`[data-sticky-kind="${kind}"]`); },
	    summary(kind) {
	      return this.card(kind)?.querySelector(':scope > .tool-summary, :scope > .thinking-group-summary');
	    },
	    details(kind) {
	      return this.card(kind)?.querySelector(':scope > .tool-details, :scope > .tool-timeline-details, :scope > .thinking-group-details');
	    },
	    navArea(kind) {
	      return this.card(kind)?.querySelector('.tool-timeline-nav-area, .tool-family-tabs');
	    },
	    footerButton(kind) {
	      return this.card(kind)?.querySelector('.tool-event-collapse-btn, .tool-timeline-collapse-btn');
	    },
	    chip(kind) {
	      return this.card(kind)?.querySelector('.tool-timeline-step, .tool-family-row, .tool-family-batch');
	    },
	    rect(selectorOrNode) {
	      const node = typeof selectorOrNode === 'string' ? document.querySelector(selectorOrNode) : selectorOrNode;
	      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom };
    },
    visibleText(node) {
      if (!node) return '';
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
        acceptNode(textNode) {
          let el = textNode.parentElement;
          while (el && el !== node.parentElement) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || (el !== node && Number(style.opacity) === 0)) {
              return NodeFilter.FILTER_REJECT;
            }
            el = el.parentElement;
          }
          return textNode.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const chunks = [];
      let current = walker.nextNode();
      while (current) {
        chunks.push(current.nodeValue.trim());
        current = walker.nextNode();
      }
      return chunks.join(' ').replace(/\\s+/g, ' ').trim();
    },
	    scrollKindToSticky(kind) {
	      const messages = this.messages();
	      const summary = this.summary(kind);
	      const messagesTop = messages.getBoundingClientRect().top;
	      const currentTop = summary.getBoundingClientRect().top;
	      messages.scrollTop += currentTop - messagesTop + 56;
	    },
	    scrollTimelineNavToSticky() {
	      const messages = this.messages();
	      const nav = this.navArea('timeline');
	      const messagesTop = messages.getBoundingClientRect().top;
	      const currentTop = nav.getBoundingClientRect().top;
	      messages.scrollTop += currentTop - messagesTop + 12;
	    },
	    metrics(kind) {
	      const messages = this.messages();
	      const card = this.card(kind);
	      const summary = this.summary(kind);
	      const details = this.details(kind);
	      const nav = this.navArea(kind);
	      const chip = this.chip(kind);
	      return {
	        scrollTop: messages.scrollTop,
	        messagesTop: messages.getBoundingClientRect().top,
	        cardClass: card?.className || '',
	        summaryTop: summary?.getBoundingClientRect().top ?? null,
	        summaryBottom: summary?.getBoundingClientRect().bottom ?? null,
	        summaryOpacity: summary ? getComputedStyle(summary).opacity : null,
	        summaryPosition: summary ? getComputedStyle(summary).position : null,
	        detailsHidden: details ? details.classList.contains('hidden') : null,
	        sourceText: this.visibleText(summary),
	        navTop: nav?.getBoundingClientRect().top ?? null,
	        navPosition: nav ? getComputedStyle(nav).position : null,
	        chipTop: chip?.getBoundingClientRect().top ?? null,
	        chipClicked: Number(chip?.dataset.clicked || '0'),
	        lastStickyChip: messages.dataset.lastStickyChip || '',
	      };
	    },
  };
}
"""


def open_sidepanel(browser, url):
    page = browser.new_page(locale="zh-CN", viewport={"width": 460, "height": 760}, device_scale_factor=1)
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script(CHROME_MOCK)
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector("#messages")
    page.evaluate(FIXTURE_JS)
    page.evaluate(HELPERS_JS)
    page.wait_for_timeout(120)
    return page, page_errors, console_errors


def reset_fixture(page):
    page.evaluate(FIXTURE_JS)
    page.evaluate(HELPERS_JS)
    page.wait_for_timeout(80)


def wait_for_sticky(page, kind):
    page.evaluate(f"window.__stickyTest.scrollKindToSticky({json.dumps(kind)})")
    page.wait_for_function(
        "(kind) => { const m = window.__stickyTest.metrics(kind); return m.summaryPosition === 'sticky' && Math.abs(m.summaryTop - m.messagesTop) <= 2; }",
        arg=kind,
    )
    page.wait_for_timeout(80)
    return page.evaluate("(kind) => window.__stickyTest.metrics(kind)", kind)


def assert_no_proxy(page):
    visible = page.locator(".tool-sticky-summary-proxy.is-visible").count()
    expect(visible == 0, f"sticky proxy should be hidden, found {visible}")


def test_non_sticky_summary_click_preserves_visual_top(page):
    reset_fixture(page)
    before = page.evaluate("window.__stickyTest.metrics('single')")
    expect(before["summaryTop"] is not None, "non-sticky: missing summary")
    page.evaluate("window.__stickyTest.summary('single').click()")
    page.wait_for_timeout(100)
    after = page.evaluate("window.__stickyTest.metrics('single')")
    expect(after["detailsHidden"] is True, "non-sticky: summary click should collapse details")
    expect_close(after["summaryTop"], before["summaryTop"], "non-sticky: collapsed header should stay visually anchored")
    assert_no_proxy(page)


def test_sticky_single_tool_header_collapses_in_place(page):
    reset_fixture(page)
    sticky = wait_for_sticky(page, "single")
    expect(sticky["summaryPosition"] == "sticky", f"single: source header should be CSS sticky {sticky}")
    expect(sticky["summaryOpacity"] == "1", f"single: source header should remain visible {sticky}")
    expect_close(sticky["summaryTop"], sticky["messagesTop"], "single: sticky header should sit on message viewport top")
    expect(sticky["sourceText"] == "全网热点趋势聚合 · 纽约时报新闻 ▾", f"single: source visible text should hide args {sticky}")
    expect("(timeout=15000)" not in sticky["sourceText"], f"single: hidden args should not appear in sticky header {sticky}")
    assert_no_proxy(page)

    before_top = sticky["summaryTop"]
    page.evaluate("window.__stickyTest.summary('single').click()")
    page.wait_for_timeout(120)
    after = page.evaluate("window.__stickyTest.metrics('single')")
    expect(after["detailsHidden"] is True, f"single: sticky header click should collapse details {after}")
    expect("tool-expanded" not in after["cardClass"], f"single: card should no longer be expanded {after}")
    expect(after["summaryOpacity"] == "1", f"single: source header should be visible after collapse {after}")
    expect_close(after["summaryTop"], before_top, "single: header should remain at sticky visual position after collapse")
    assert_no_proxy(page)


def test_sticky_timeline_header_preserves_visible_preview_and_footer_collapse(page):
    reset_fixture(page)
    sticky = wait_for_sticky(page, "timeline")
    expect(sticky["summaryPosition"] == "sticky", f"timeline: source header should be CSS sticky {sticky}")
    expect(sticky["summaryOpacity"] == "1", f"timeline: source header should remain visible {sticky}")
    expect_close(sticky["summaryTop"], sticky["messagesTop"], "timeline: sticky header should sit on message viewport top")
    expect("35 步" in sticky["sourceText"], f"timeline: sticky header should include visible summary preview {sticky}")
    assert_no_proxy(page)

    before_top = sticky["summaryTop"]
    page.evaluate("window.__stickyTest.footerButton('timeline').click()")
    page.wait_for_timeout(120)
    after = page.evaluate("window.__stickyTest.metrics('timeline')")
    expect(after["detailsHidden"] is True, f"timeline: footer collapse should hide details {after}")
    expect("tool-timeline-expanded" not in after["cardClass"], f"timeline: card should no longer be expanded {after}")
    expect_close(after["summaryTop"], before_top, "timeline: footer collapse should keep header visually anchored")
    assert_no_proxy(page)


def test_sticky_timeline_chip_is_directly_clickable(page):
    reset_fixture(page)
    wait_for_sticky(page, "timeline")
    page.evaluate("window.__stickyTest.scrollTimelineNavToSticky()")
    page.wait_for_timeout(120)
    before = page.evaluate("window.__stickyTest.metrics('timeline')")
    expect(before["summaryPosition"] == "sticky", f"timeline chip: header should be sticky {before}")
    expect(before["navPosition"] == "sticky", f"timeline chip: nav area should be sticky {before}")
    expect(before["navTop"] >= before["summaryBottom"] - 2, f"timeline chip: nav should sit below sticky header {before}")
    assert_no_proxy(page)

    page.evaluate("window.__stickyTest.chip('timeline').click()")
    page.wait_for_timeout(120)
    after = page.evaluate("window.__stickyTest.metrics('timeline')")
    expect(after["chipClicked"] == before["chipClicked"] + 1, f"timeline chip click should reach real chip {after}")
    expect("到达页面" in after["lastStickyChip"], f"timeline chip click reached wrong target {after}")
    expect(after["detailsHidden"] is False, f"timeline chip click should not collapse timeline {after}")
    expect_close(after["scrollTop"], before["scrollTop"], "timeline chip click should keep the scroll position anchored")
    expect_close(after["navTop"], before["navTop"], "timeline chip click should keep the sticky chip header visually anchored")


def test_sticky_thinking_header_hides_preview_and_collapses_in_place(page):
    reset_fixture(page)
    sticky = wait_for_sticky(page, "thinking")
    expect(sticky["summaryPosition"] == "sticky", f"thinking: source header should be CSS sticky {sticky}")
    expect(sticky["summaryOpacity"] == "1", f"thinking: source header should remain visible {sticky}")
    expect_close(sticky["summaryTop"], sticky["messagesTop"], "thinking: sticky header should sit on message viewport top")
    expect("preview should hide" not in sticky["sourceText"], f"thinking: hidden expanded preview should not appear in sticky header {sticky}")
    assert_no_proxy(page)

    before_top = sticky["summaryTop"]
    page.evaluate("window.__stickyTest.summary('thinking').click()")
    page.wait_for_timeout(120)
    after = page.evaluate("window.__stickyTest.metrics('thinking')")
    expect(after["detailsHidden"] is True, f"thinking: sticky header click should collapse details {after}")
    expect("thinking-group-expanded" not in after["cardClass"], f"thinking: card should no longer be expanded {after}")
    expect_close(after["summaryTop"], before_top, "thinking: header should remain at sticky visual position after collapse")
    assert_no_proxy(page)


def main():
    with serve_repo() as url, sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"))
        try:
            page, page_errors, console_errors = open_sidepanel(browser, url)
            try:
                test_non_sticky_summary_click_preserves_visual_top(page)
                test_sticky_single_tool_header_collapses_in_place(page)
                test_sticky_timeline_header_preserves_visible_preview_and_footer_collapse(page)
                test_sticky_timeline_chip_is_directly_clickable(page)
                test_sticky_thinking_header_hides_preview_and_collapses_in_place(page)
                expect(not page_errors, "sidepanel sticky page errors: " + json.dumps(page_errors, ensure_ascii=False))
                expect(not console_errors, "sidepanel sticky console errors: " + json.dumps(console_errors, ensure_ascii=False))
            finally:
                page.close()
        finally:
            browser.close()
    print("sticky behavior checks passed")


if __name__ == "__main__":
    main()
