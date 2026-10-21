#!/usr/bin/env python3
from argparse import ArgumentParser
from contextlib import contextmanager
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import serve_repository


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
DEFAULT_SCREENSHOT = Path("/tmp/qingzhou-tool-timeline-visual-test.png")
DEFAULT_GIF = Path("/tmp/qingzhou-tool-timeline-visual-test.gif")


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


@contextmanager
def serve_sidepanel():
    with serve_repository() as base_url:
        yield f"{base_url}/tests/tool-timeline/visual-test.html"


def read_json(path):
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def default_operations_from_page(page):
    return json.loads(page.locator("#operation-flow-input").input_value())


def apply_conversation_flow(page, flow):
    if flow is None:
        return
    if isinstance(flow, list):
        flow = {"title": "录制对话流", "entries": flow}
    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", flow)


def apply_scenario(page, scenario):
    if not scenario:
        return
    page.evaluate("(scenario) => window.visualTimelineTest.renderScenario(scenario)", scenario)


def run_builtin_checks(page):
    scenarios = ["mixed", "thinking", "data", "code", "permission", "error", "long"]
    results = []
    for scenario in scenarios:
        page.click(f'[data-scenario="{scenario}"]')
        page.wait_for_selector(".msg-tool-timeline")
        page.wait_for_timeout(120)

        timeline_count = page.locator(".msg-tool-timeline").count()
        expect(timeline_count >= 1, f"{scenario}: missing timeline group")
        expect(page.locator(".msg-tool-timeline .tool-caret").count() >= timeline_count, f"{scenario}: missing timeline caret")
        expect(page.locator(".msg-tool-timeline .tool-timeline-head").count() == 0, f"{scenario}: redundant timeline head leaked")
        if scenario == "long":
            expect(page.locator(".tool-family-trace").count() >= 1, "long: missing family trace")
            expect(page.locator(".tool-family-tabs").count() == 1, "long: missing horizontal family tabs")
            expect(page.locator(".tool-family-row").count() >= 3, "long: missing family rows")
            expect(page.locator(".tool-family-panel.active").count() == 1, "long: expected one active family panel")
            expect(page.locator(".tool-timeline-step").count() <= 12, "long: raw pill wall leaked")
            expect(page.locator(".tool-timeline-raw-audit").count() == 0, "long: raw audit disclosure should be removed")
        else:
            expect(page.locator(".tool-timeline-step").count() >= 1, f"{scenario}: missing timeline steps")
        expect_chat_lane_widths(page, f"{scenario}: collapsed")

        if scenario == "thinking":
            expect(page.locator(".msg-thinking-group").count() == 1, "thinking: completed thinking should be grouped")
            expect(page.locator(".msg-thinking .thinking-card").count() == 0, "thinking: thinking leaked as standalone card")
            thought_summary = page.locator(".msg-thinking-group .thinking-group-summary").first
            thought_details = page.locator(".msg-thinking-group .thinking-group-details").first
            expect(details_hidden(thought_details), "thinking: lane should be collapsed by default")
            expect(thought_summary.get_attribute("aria-expanded") == "false", "thinking: collapsed summary aria should be false")
            expect(page.locator(".msg-thinking-group.thinking-group-expanded").count() == 0, "thinking: collapsed lane should not use expanded card shell")
            expect(thought_summary.locator(".thinking-group-preview").first.is_visible(), "thinking: collapsed summary should show preview")
            tool_summary = page.locator(".msg-tool-timeline .tool-timeline-summary").first
            header_heights = [rounded_height(thought_summary), rounded_height(tool_summary)]
            expect(abs(header_heights[0] - header_heights[1]) <= 1, f"thinking: collapsed lane headers should share height {header_heights}")
            title_styles = page.evaluate("""() => {
                const thinkingTitle = document.querySelector('.msg-thinking-group .thinking-group-title');
                const toolTitle = document.querySelector('.msg-tool-timeline .tool-timeline-summary .tool-name');
                const pick = (node) => {
                  const style = getComputedStyle(node);
                  return {
                    color: style.color,
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    fontFamily: style.fontFamily,
                  };
                };
                return thinkingTitle && toolTitle ? { thinking: pick(thinkingTitle), tool: pick(toolTitle) } : null;
            }""")
            expect(title_styles and title_styles["thinking"] == title_styles["tool"], f"thinking: lane title styles should match {title_styles}")
            lane_order = page.evaluate("""() => {
                const thinking = document.querySelector('.msg-thinking-group');
                const tool = document.querySelector('.msg-tool-timeline');
                return thinking && tool
                  ? thinking.getBoundingClientRect().top < tool.getBoundingClientRect().top
                  : false;
            }""")
            expect(lane_order, "thinking: thinking lane should render above tool lane")
            lane_alignment = page.evaluate("""() => {
                const thinking = document.querySelector('.msg-thinking-group');
                const tool = document.querySelector('.msg-tool-timeline');
                const thinkingDot = document.querySelector('.msg-thinking-group .thinking-dot');
                const toolDot = document.querySelector('.msg-tool-timeline .tool-timeline-summary .dot');
                return {
                  outer: thinking && tool ? Math.abs(thinking.getBoundingClientRect().left - tool.getBoundingClientRect().left) : 999,
                  dot: thinkingDot && toolDot ? Math.abs(thinkingDot.getBoundingClientRect().left - toolDot.getBoundingClientRect().left) : 999,
                };
            }""")
            expect(lane_alignment["outer"] <= 1 and lane_alignment["dot"] <= 1, f"thinking: lane left edges should align {lane_alignment}")
            thought_summary.click()
            page.wait_for_timeout(80)
            expect(not details_hidden(thought_details), "thinking: expand failed")
            expect_chat_lane_widths(page, "thinking: thought expanded")
            expect(page.locator(".msg-thinking-group.thinking-group-expanded").count() == 1, "thinking: expanded lane should use single card shell")
            expect(not thought_summary.locator(".thinking-group-preview").first.is_visible(), "thinking: expanded header preview should be hidden")
            expect(abs(rounded_height(thought_summary) - header_heights[0]) <= 1, "thinking: expanded header height should match collapsed height")
            detail_box = thought_details.evaluate("""(node) => ({
                borderTopWidth: getComputedStyle(node).borderTopWidth,
                marginTop: getComputedStyle(node).marginTop
            })""")
            expect(detail_box["borderTopWidth"] == "0px", f"thinking: details should not be a second box ({detail_box})")
            expect(detail_box["marginTop"] == "0px", f"thinking: details should be attached to header ({detail_box})")
            expect(page.locator(".msg-thinking-group .thinking-group-slot-nav span").first.text_content().strip() == "3/3", "thinking: should default to latest thought")
            page.locator('.msg-thinking-group .thinking-group-nav-btn[data-thinking-nav-direction="-1"]').click()
            page.wait_for_timeout(80)
            expect(page.locator(".msg-thinking-group .thinking-group-slot-nav span").first.text_content().strip() == "2/3", "thinking: previous navigation failed")
            expect("搜索结果" in page.locator(".msg-thinking-group .thinking-group-body").first.text_content(), "thinking: previous thought body did not render")

        if scenario == "permission":
            expect(page.locator(".tool-timeline-summary-waiting, .tool-timeline-step.waiting").count() >= 1, "permission: missing waiting state")
        if scenario == "error":
            expect(page.locator(".tool-timeline-step.error").count() >= 1, "error: missing error state")

        first_summary = page.locator(".msg-tool-timeline .tool-timeline-summary").first
        first_details = page.locator(".msg-tool-timeline .tool-timeline-details").first
        expect("hidden" in (first_details.get_attribute("class") or ""), f"{scenario}: tool timeline should be collapsed by default")
        expect(first_summary.is_visible(), f"{scenario}: collapsed tool summary should be visible")
        expect(first_summary.get_attribute("aria-expanded") == "false", f"{scenario}: collapsed summary aria should be false")
        expect(first_summary.locator(".tool-caret").first.text_content().strip() == "▸", f"{scenario}: collapsed summary caret should point right")
        expect(first_details.locator(".tool-timeline-slot-body").count() == 0, f"{scenario}: collapsed timeline should keep its active slot lazy")
        first_summary.click()
        page.wait_for_timeout(80)
        expect("hidden" not in (first_details.get_attribute("class") or ""), f"{scenario}: initial expand failed")
        expect(first_summary.is_visible(), f"{scenario}: expanded summary should remain visible")
        expect(first_summary.get_attribute("aria-expanded") == "true", f"{scenario}: expanded summary aria should be true")
        expect(first_summary.locator(".tool-caret").first.text_content().strip() == "▾", f"{scenario}: expanded summary caret should point down")
        expect(first_details.locator(".tool-timeline-slot-body").count() == 1, f"{scenario}: expanded timeline should materialize its active slot")
        expect_chat_lane_widths(page, f"{scenario}: tool expanded")
        if scenario in ("mixed", "data"):
            expect(page.locator(".tool-data-table").count() >= 1, f"{scenario}: missing data table evidence")
        if scenario == "code":
            expect(page.locator(".js-code-block, .json-block").count() >= 1, f"{scenario}: missing code evidence")
        if scenario == "long":
            # Measure visible geometry after expansion, independent of grid/flex implementation.
            tabs_metrics = page.locator(".tool-family-tabs").first.evaluate("""node => {
                const bounds = node.getBoundingClientRect();
                const rows = [...node.querySelectorAll('.tool-family-row')];
                return {
                    width: bounds.width,
                    scrollWidth: node.scrollWidth,
                    clientWidth: node.clientWidth,
                    rowsFit: rows.every(row => {
                        const box = row.getBoundingClientRect();
                        return box.width > 0 && box.height > 0 && box.left >= bounds.left - 1
                            && box.right <= bounds.right + 1 && box.top >= bounds.top - 1
                            && box.bottom <= bounds.bottom + 1;
                    }),
                };
            }""")
            expect(tabs_metrics["width"] > 0 and tabs_metrics["rowsFit"], f"long: family tabs should remain visible within their container ({tabs_metrics})")
            expect(tabs_metrics["scrollWidth"] <= tabs_metrics["clientWidth"] + 1, "long: family tabs should not horizontally scroll")
            expect(page.locator(".tool-timeline-slot-nav").count() == 1, "long: missing detail navigation")
            expect(page.locator(".tool-timeline-nav-btn").count() == 2, "long: expected two detail nav buttons")
            expect_tool_slot_nav_family_scoped(page, "long")
            expect_tool_family_menu_has_stable_pager(page, "long")
        elif first_details.locator(".tool-timeline-slot-nav").count() == 1:
            expect_regular_tool_nav_positions_stable(page, first_details, scenario)
        expect_shared_timeline_pager_geometry(page, scenario)
        if page.locator(".msg-tool-timeline .tool-timeline-rail").count():
            rail_metrics = page.locator(".msg-tool-timeline .tool-timeline-rail").first.evaluate("""(node) => ({
                borderTopWidth: getComputedStyle(node).borderTopWidth,
                backgroundImage: getComputedStyle(node).backgroundImage
            })""")
            expect(rail_metrics["borderTopWidth"] == "0px", f"{scenario}: pill rail should not have outer border")
            expect(rail_metrics["backgroundImage"] == "none", f"{scenario}: pill rail should not have decorative background")
        expect(page.locator(".msg-tool-timeline .tool-timeline-collapse-btn").count() >= 1, f"{scenario}: missing muted collapse action")
        expect(page.locator(".msg-tool-timeline button.tool-timeline-duration").count() == 0, f"{scenario}: duration should not be a button")
        footer_heights = page.locator(".msg-tool-timeline .tool-timeline-footer-row").first.evaluate("""(node) => {
            const items = [...node.querySelectorAll('.tool-timeline-raw-btn:not(.hidden), .tool-timeline-duration, .tool-timeline-collapse-btn')];
            return items.map(item => Math.round(item.getBoundingClientRect().height));
        }""")
        expect(len(set(footer_heights)) <= 1, f"{scenario}: footer muted actions should have equal height {footer_heights}")
        if page.locator(".msg-tool-timeline .tool-timeline-raw-btn:not(.hidden)").count():
            page.locator(".msg-tool-timeline .tool-timeline-raw-btn").first.click()
            page.wait_for_timeout(45)
            panel = page.locator(".msg-tool-timeline .tool-timeline-raw-panel").first
            expect("hidden" not in (panel.get_attribute("class") or ""), f"{scenario}: raw panel did not open")
            expect(panel.locator("summary").count() == 0, f"{scenario}: raw panel should not expose native details summary")
            raw_width = panel.locator(".copyable-code-block").first.evaluate("(node) => node.getBoundingClientRect().width")
            details_width = first_details.evaluate("(node) => node.getBoundingClientRect().width")
            expect(raw_width >= details_width - 24, f"{scenario}: expanded raw should span the footer width ({raw_width} < {details_width})")
        page.locator(".msg-tool-timeline .tool-timeline-collapse-btn").first.click()
        page.wait_for_timeout(80)
        expect("hidden" in (first_details.get_attribute("class") or ""), f"{scenario}: collapse failed")
        expect(first_summary.is_visible(), f"{scenario}: collapsed summary should be visible")
        expect(first_summary.get_attribute("aria-expanded") == "false", f"{scenario}: footer collapse should reset summary aria")
        expect(first_summary.locator(".tool-caret").first.text_content().strip() == "▸", f"{scenario}: footer collapse should reset caret")
        first_summary.click()
        page.wait_for_timeout(80)
        expect("hidden" not in (first_details.get_attribute("class") or ""), f"{scenario}: expand failed")
        expect(first_summary.is_visible(), f"{scenario}: expanded summary should remain visible after re-expand")
        first_summary.click()
        page.wait_for_timeout(80)
        expect("hidden" in (first_details.get_attribute("class") or ""), f"{scenario}: header collapse failed")
        first_summary.click()
        page.wait_for_timeout(80)
        expect("hidden" not in (first_details.get_attribute("class") or ""), f"{scenario}: header re-expand failed")

        step_count = page.locator(".msg-tool-timeline .tool-timeline-step, .msg-tool-timeline .tool-family-row, .msg-tool-timeline .tool-family-batch").count()
        if step_count > 1:
            page.locator(".msg-tool-timeline .tool-timeline-step, .msg-tool-timeline .tool-family-row, .msg-tool-timeline .tool-family-batch").nth(1).click()
            page.wait_for_timeout(80)
            expect(page.locator(".msg-tool-timeline .tool-timeline-step.active, .msg-tool-timeline .tool-family-row.active, .msg-tool-timeline .tool-family-batch.active").count() >= 1, f"{scenario}: step activation failed")

        if scenario == "long":
            collect_family = page.locator('.tool-family-row[data-tool-family-id="collect"]')
            expect(collect_family.count() == 1, "long: missing collect family row")
            collect_family.click()
            page.wait_for_timeout(80)
            expect(page.locator('.tool-family-panel[data-tool-family-id="collect"].active').count() == 1, "long: collect family panel did not activate")
            expect_read_article_batches_use_titles(page, "long")
            expect_page_scoped_batches_avoid_tab_ids(page, "long")
            clicked_article_batch = page.evaluate("""() => {
                const batch = [...document.querySelectorAll('.tool-family-batch[data-tool-family-id="collect"]')]
                  .find(node => node.textContent.includes('采集正文'));
                if (!batch) return false;
                batch.click();
                return true;
            }""")
            expect(clicked_article_batch, "long: missing read_article batch")
            page.wait_for_timeout(80)
            expect_bounded_article_body(page, ".msg-tool-timeline .tool-article-body", "long")
            expect_timeline_raw_panel_scroll(page, "long")
            expect_family_aware_navigation(page)

        page.click("#patch-running")
        page.wait_for_timeout(120)
        results.append(collect_page_stats(page, scenario))

    expect_thinking_lane_grouping_stability(page)
    expect_single_tool_lane_width_alignment(page)
    expect_grouping_boundary_cases(page)
    expect_lane_widths_across_viewports(page)
    expect_timeline_mode_thresholds(page)
    expect_patch_state_preservation(page)
    expect_motion_and_view_state(page)
    expect_single_tool_scroll_cases(page)
    return results


def expect_thinking_lane_grouping_stability(page):
    first_frame = [
        {"type": "user", "_uiKey": "stable-u1", "text": "查一下趋势"},
        {"type": "thinking", "_uiKey": "stable-th1", "text": "先判断任务边界", "streaming": True},
    ]
    later_frame = [
        {"type": "user", "_uiKey": "stable-u1", "text": "查一下趋势"},
        {"type": "thinking", "_uiKey": "stable-th1", "text": "先判断任务边界", "streaming": False},
        {"type": "tool", "_uiKey": "stable-t1", "toolCallId": "stable-t1", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
        {"type": "thinking", "_uiKey": "stable-th2", "text": "再读取正文证据", "streaming": True},
    ]
    grouped = page.evaluate(
        """([firstFrame, laterFrame]) => ({
            first: window.visualTimelineTest.debugGroupedTranscriptEntries(firstFrame),
            later: window.visualTimelineTest.debugGroupedTranscriptEntries(laterFrame),
        })""",
        [first_frame, later_frame],
    )
    first_thinking = next((item for item in grouped["first"] if item["type"] == "thinking-group"), None)
    later_thinking = next((item for item in grouped["later"] if item["type"] == "thinking-group"), None)
    expect(first_thinking is not None, "thinking stability: first streaming frame should already be a thinking group")
    expect(later_thinking is not None, "thinking stability: later frame should keep thinking group")
    expect(first_thinking["key"] == later_thinking["key"], "thinking stability: thinking group key changed across streaming/completed frames")
    expect(not any(item["type"] == "thinking" for item in grouped["first"]), "thinking stability: first frame leaked standalone thinking")
    expect(not any(item["type"] == "thinking" for item in grouped["later"]), "thinking stability: later frame leaked standalone thinking")
    expect(any(item["type"] == "tool" or item["type"] == "tool-group" for item in grouped["later"]), "thinking stability: later frame lost tool lane")
    later_types = [item["type"] for item in grouped["later"] if item["type"] in ("thinking-group", "tool", "tool-group")]
    expect(later_types[:2] in (["thinking-group", "tool"], ["thinking-group", "tool-group"]), f"thinking stability: thinking lane should precede tool lane ({later_types})")
    interleaved_frame = [
        {"type": "user", "_uiKey": "turn-u1", "text": "查天气"},
        {"type": "assistant", "_uiKey": "turn-a0", "content": "我先检查页面。"},
        {"type": "tool", "_uiKey": "turn-t1", "toolCallId": "turn-t1", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
        {"type": "thinking", "_uiKey": "turn-th1", "text": "页面结果需要再读正文", "streaming": False},
        {"type": "tool", "_uiKey": "turn-t2", "toolCallId": "turn-t2", "name": "read_article", "args": {"source": "auto", "limit": 4000}, "result": {"text": "正文"}},
        {"type": "assistant", "_uiKey": "turn-a1", "content": "结论如下。"},
    ]
    interleaved = page.evaluate("(frame) => window.visualTimelineTest.debugGroupedTranscriptEntries(frame)", interleaved_frame)
    interleaved_types = [item["type"] for item in interleaved]
    expect(interleaved_types == ["user", "assistant", "thinking-group", "tool-group", "assistant"], f"turn model: unexpected top-level order {interleaved_types}")
    expect(interleaved[2]["key"].endswith(":thinking") and interleaved[3]["key"].endswith(":tools"), f"turn model: lane keys should be turn-derived {interleaved}")
    expect(len(interleaved[2]["entries"]) == 1 and len(interleaved[3]["entries"]) == 2, f"turn model: lane contents mismatch {interleaved}")

    long_streaming_text = "开头标记 " + ("中间内容 " * 18) + "尾部标记 最新串流"
    page.evaluate(
        """(text) => window.visualTimelineTest.renderConversationFlow({
            title: '思考尾部预览',
            entries: [
              { type: 'user', _uiKey: 'tail-u1', text: '测试思考预览' },
              { type: 'thinking', _uiKey: 'tail-th1', text, streaming: true },
              { type: 'tool', _uiKey: 'tail-t1', toolCallId: 'tail-t1', name: 'open_tab', args: { url: 'https://example.com' }, result: { title: '页面' } }
            ]
        })""",
        long_streaming_text,
    )
    page.wait_for_timeout(80)
    preview = page.locator(".msg-thinking-group .thinking-group-preview").first.text_content()
    expect("尾部标记" in preview, f"thinking tail preview: collapsed preview should include latest tail ({preview})")
    expect(details_hidden(page.locator(".msg-thinking-group .thinking-group-details").first), "thinking tail preview: lane should remain collapsed while streaming")
    expect(page.locator(".msg-thinking-group .thinking-group-preview-buffer").count() == 0, "thinking tail preview: legacy double-buffer preview should be removed")
    expect(page.locator(".msg-thinking-group .thinking-group-preview-track").count() == 1, "thinking tail preview: expected one stable scrolling track")
    preview_motion = page.locator(".msg-thinking-group .thinking-group-preview-track").first.evaluate(
        """(node) => {
            const preview = node.closest('.thinking-group-preview');
            const text = node.querySelector('.thinking-group-preview-text');
            const rawOffset = text?.style?.getPropertyValue('--thinking-preview-offset') || '0';
            const offset = Number.parseFloat(rawOffset);
            const virtualLeft = Math.max(0, -(Number.isFinite(offset) ? offset : 0));
            const max = Math.max(0, (text?.scrollWidth || node.scrollWidth || 0) - node.clientWidth);
            const previewStyle = getComputedStyle(preview);
            const trackStyle = getComputedStyle(node);
            return {
                transitionProperty: trackStyle.transitionProperty,
                transitionTimingFunction: trackStyle.transitionTimingFunction,
                animationName: trackStyle.animationName,
                opacityTransition: trackStyle.transitionProperty.includes('opacity'),
                maskImage: previewStyle.maskImage || 'none',
                webkitMaskImage: previewStyle.webkitMaskImage || 'none',
                scrollLeft: Math.round(node.scrollLeft),
                virtualLeft: Math.round(virtualLeft),
                tailDistance: Math.round(Math.max(0, max - virtualLeft)),
            };
        }"""
    )
    expect(preview_motion["transitionProperty"] in ("all", "none"), f"thinking tail preview: should not use CSS swap transitions {preview_motion}")
    expect(not preview_motion["opacityTransition"], f"thinking tail preview: should not fade track {preview_motion}")
    expect(preview_motion["animationName"] == "none", f"thinking tail preview: should not use ticker animation {preview_motion}")
    expect(preview_motion["maskImage"] == "none" and preview_motion["webkitMaskImage"] == "none", f"thinking tail preview: should not use fade masks {preview_motion}")
    expect(preview_motion["tailDistance"] <= 2, f"thinking tail preview: initial render should align to tail {preview_motion}")
    patched_preview = page.evaluate("() => window.visualTimelineTest.debugPatchThinkingPreviewScroller()")
    expect(patched_preview["sameNode"] == [True, True], f"thinking patch preview: preview node should be preserved {patched_preview}")
    expect(patched_preview["sameTrack"] == [True, True], f"thinking patch preview: track node should be preserved {patched_preview}")
    expect(patched_preview["bufferCount"] == 0 and patched_preview["trackCount"] == 1, f"thinking patch preview: stable track state invalid {patched_preview}")
    expect(all(item["left"] > 0 for item in patched_preview["scrollTrace"]), f"thinking patch preview: should stay near tail, not reset to start {patched_preview}")
    expect("尾部三" in patched_preview["text"], f"thinking patch preview: latest text missing {patched_preview}")


def expect_single_tool_lane_width_alignment(page):
    page.evaluate("""() => window.visualTimelineTest.renderConversationFlow({
        title: '单工具宽度对齐',
        entries: [
          { type: 'user', _uiKey: 'single-width-u1', text: '查天气' },
          { type: 'thinking', _uiKey: 'single-width-th1', text: 'Humidity: 88% - Wind: 需要汇报天气。', streaming: false },
          { type: 'tool', _uiKey: 'single-width-t1', toolCallId: 'single-width-t1', name: 'read_article', args: { source: 'auto', tabId: 1887129311, limit: 4000 }, result: { title: '天气', text: '杭州现在的天气' } }
        ]
    })""")
    page.wait_for_timeout(100)
    metrics = page.evaluate("""() => {
        const thinkingSummary = document.querySelector('.thinking-group-summary')?.getBoundingClientRect();
        const toolSummary = document.querySelector('.msg-tool > .tool-summary')?.getBoundingClientRect();
        const thinkingRoot = document.querySelector('.msg-thinking-group')?.getBoundingClientRect();
        const toolRoot = document.querySelector('.msg-tool')?.getBoundingClientRect();
        return {
            thinkingSummary: Math.round(thinkingSummary?.width || 0),
            toolSummary: Math.round(toolSummary?.width || 0),
            thinkingRoot: Math.round(thinkingRoot?.width || 0),
            toolRoot: Math.round(toolRoot?.width || 0),
        };
    }""")
    expect(abs(metrics["thinkingSummary"] - metrics["toolSummary"]) <= 1, f"single-tool lane width mismatch {metrics}")
    expect(abs(metrics["thinkingRoot"] - metrics["toolRoot"]) <= 1, f"single-tool root width mismatch {metrics}")


def expect_grouping_boundary_cases(page):
    one_tool = [
        {"type": "user", "_uiKey": "group-u1", "text": "打开页面"},
        {"type": "tool", "_uiKey": "group-t1", "toolCallId": "group-t1", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
        {"type": "assistant", "_uiKey": "group-a1", "content": "完成"},
    ]
    two_tools = [
        {"type": "user", "_uiKey": "group-u2", "text": "连续打开并读取"},
        {"type": "tool", "_uiKey": "group-t2", "toolCallId": "group-t2", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
        {"type": "tool", "_uiKey": "group-t3", "toolCallId": "group-t3", "name": "read_article", "args": {"source": "auto", "limit": 4000}, "result": {"text": "正文"}},
    ]
    separated_tools = [
        {"type": "user", "_uiKey": "group-u3", "text": "分开做"},
        {"type": "tool", "_uiKey": "group-t4", "toolCallId": "group-t4", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
        {"type": "assistant", "_uiKey": "group-a2", "content": "先看这个"},
        {"type": "tool", "_uiKey": "group-t5", "toolCallId": "group-t5", "name": "read_article", "args": {"source": "auto", "limit": 4000}, "result": {"text": "正文"}},
    ]
    empty_thinking = [
        {"type": "user", "_uiKey": "group-u4", "text": "不用思考卡"},
        {"type": "thinking", "_uiKey": "group-th-empty", "text": "", "streaming": False},
        {"type": "assistant", "_uiKey": "group-a3", "content": "直接回答"},
    ]
    cases = page.evaluate(
        """([oneTool, twoTools, separatedTools, emptyThinking]) => ({
            oneTool: window.visualTimelineTest.debugGroupedTranscriptEntries(oneTool).map(item => item.type),
            twoTools: window.visualTimelineTest.debugGroupedTranscriptEntries(twoTools).map(item => item.type),
            separatedTools: window.visualTimelineTest.debugGroupedTranscriptEntries(separatedTools).map(item => item.type),
            emptyThinking: window.visualTimelineTest.debugGroupedTranscriptEntries(emptyThinking).map(item => item.type),
        })""",
        [one_tool, two_tools, separated_tools, empty_thinking],
    )
    expect(cases["oneTool"] == ["user", "tool", "assistant"], f"grouping boundary: one tool should stay single {cases}")
    expect(cases["twoTools"] == ["user", "tool-group"], f"grouping boundary: two tools should become timeline {cases}")
    expect(cases["separatedTools"] == ["user", "tool", "assistant", "tool"], f"grouping boundary: assistant should split tool groups {cases}")
    expect(cases["emptyThinking"] == ["user", "assistant"], f"grouping boundary: empty non-streaming thinking should be dropped {cases}")


def expect_lane_widths_across_viewports(page):
    flow = {
        "title": "lane 宽度矩阵",
        "entries": [
            {"type": "user", "_uiKey": "lane-u1", "text": "查天气和正文"},
            {"type": "thinking", "_uiKey": "lane-th1", "text": "Humidity: 88% - Wind: 需要继续读取正文证据。", "streaming": False},
            {"type": "tool", "_uiKey": "lane-single", "toolCallId": "lane-single", "name": "read_article", "args": {"source": "auto", "tabId": 1887129311, "limit": 4000}, "result": {"title": "天气", "text": "杭州现在的天气"}},
            {"type": "assistant", "_uiKey": "lane-a1", "content": "单工具已读取，再看连续工具。"},
            {"type": "tool", "_uiKey": "lane-t1", "toolCallId": "lane-t1", "name": "open_tab", "args": {"url": "https://example.com/a"}, "result": {"title": "页面 A"}},
            {"type": "tool", "_uiKey": "lane-t2", "toolCallId": "lane-t2", "name": "read_article", "args": {"source": "auto", "limit": 4000}, "result": {"title": "页面 A", "text": "正文 A"}},
        ],
    }
    for width in (320, 360, 420, 560):
        page.evaluate("(width) => window.visualTimelineTest.setDeviceWidth(width)", width)
        page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", flow)
        page.wait_for_timeout(100)
        metrics = page.evaluate("""() => {
            const pick = (selector) => {
                const node = document.querySelector(selector);
                return node ? Math.round(node.getBoundingClientRect().width) : 0;
            };
            const device = document.querySelector('.visual-device');
            return {
                thinking: pick('.thinking-group-summary'),
                singleTool: pick('.msg-tool > .tool-summary'),
                timeline: pick('.msg-tool-timeline > .tool-timeline-summary'),
                deviceClient: device?.clientWidth || 0,
                deviceScroll: device?.scrollWidth || 0,
            };
        }""")
        widths = [metrics["thinking"], metrics["singleTool"], metrics["timeline"]]
        expect(all(value > 0 for value in widths), f"lane width matrix {width}: missing lane {metrics}")
        expect(max(widths) - min(widths) <= 1, f"lane width matrix {width}: collapsed lane widths differ {metrics}")
        expect(metrics["deviceScroll"] <= metrics["deviceClient"] + 1, f"lane width matrix {width}: device horizontal overflow {metrics}")


def expect_timeline_mode_thresholds(page):
    def make_flow(count):
        return {
            "title": f"{count} 步聚合阈值",
            "entries": [
                {"type": "user", "_uiKey": f"threshold-u-{count}", "text": f"连续 {count} 步工具"},
                *[
                    {
                        "type": "tool",
                        "_uiKey": f"threshold-{count}-{index}",
                        "toolCallId": f"threshold-{count}-{index}",
                        "name": "open_tab" if index % 2 == 0 else "read_article",
                        "args": {"url": f"https://example.com/{index}"} if index % 2 == 0 else {"source": "auto", "tabId": 1000 + index, "limit": 4000},
                        "result": {"title": f"页面 {index}", "text": "正文"} if index % 2 else {"title": f"页面 {index}", "url": f"https://example.com/{index}"},
                    }
                    for index in range(count)
                ],
            ],
        }

    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", make_flow(12))
    page.wait_for_timeout(80)
    page.locator(".msg-tool-timeline .tool-timeline-summary").first.click()
    page.wait_for_timeout(80)
    expect(page.locator(".tool-timeline-rail").count() == 1, "timeline threshold: 12 tools should use pill rail")
    expect(page.locator(".tool-family-trace").count() == 0, "timeline threshold: 12 tools should not use family trace")
    expect(page.locator(".tool-timeline-step").count() == 12, "timeline threshold: 12 tools should render 12 steps")

    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", make_flow(13))
    page.wait_for_timeout(80)
    page.locator(".msg-tool-timeline .tool-timeline-summary").first.click()
    page.wait_for_timeout(80)
    expect(page.locator(".tool-family-trace").count() == 1, "timeline threshold: 13 tools should use family trace")
    expect(page.locator(".tool-family-row").count() >= 2, "timeline threshold: 13 tools should group into families")
    expect(page.locator(".tool-timeline-rail").count() == 0, "timeline threshold: 13 tools should hide raw pill rail")


def expect_plugin_tool_family_grouping(page):
    metrics = page.evaluate("() => window.visualTimelineTest.debugPluginToolFamilyGrouping()")
    row_texts = [item["text"] for item in metrics["familyRows"]]
    batch_texts = [item["text"] for item in metrics["batches"]]
    expect(metrics["timelineCount"] == 1, f"plugin family: expected one timeline {metrics}")
    expect(metrics["rawStepCount"] == 0, f"plugin family: should use family trace, not raw steps {metrics}")
    expect(any(item["id"] == "plugin:research" and "研究" in item["text"] for item in metrics["familyRows"]), f"plugin family: missing research row {metrics}")
    expect(any(item["id"] == "plugin:artifact" and "生成产物" in item["text"] for item in metrics["familyRows"]), f"plugin family: missing artifact row {metrics}")
    expect(any("抽取B站搜索结果" in text and "×11" in text for text in batch_texts), f"plugin family: repeated plugin tool should batch by title {metrics}")
    expect(any("设置B站搜索关键词" in text for text in batch_texts), f"plugin family: missing plugin title action {metrics}")
    expect(any("写出 CSV" in text for text in batch_texts), f"plugin family: missing second plugin category action {metrics}")
    expect("研究" in " ".join(row_texts), f"plugin family: summary should expose plugin category labels {metrics}")


def expect_mcp_plugin_tool_family_grouping(page):
    metrics = page.evaluate("() => window.visualTimelineTest.debugMcpPluginToolFamilyGrouping()")
    row_texts = [item["text"] for item in metrics["familyRows"]]
    combined = " ".join(row_texts)
    expect(metrics["timelineCount"] == 1, f"mcp plugin family: expected one timeline {metrics}")
    expect(any(item["id"] == "mcp" and "MCP" in item["text"] for item in metrics["familyRows"]), f"mcp plugin family: missing MCP row {metrics}")
    expect("extension" not in combined.lower(), f"mcp plugin family: leaked extension category {metrics}")


def expect_patch_state_preservation(page):
    flow = {
        "title": "patch 状态保持",
        "entries": [
            {"type": "user", "_uiKey": "patch-u1", "text": "运行脚本后更新"},
            {"type": "tool", "_uiKey": "patch-t1", "toolCallId": "patch-t1", "name": "open_tab", "args": {"url": "https://example.com"}, "result": {"title": "页面"}},
            {"type": "tool", "_uiKey": "patch-t2", "toolCallId": "patch-t2", "name": "run_script", "args": {"code": "return rows;"}, "result": None, "isRunning": True, "argsIncomplete": True, "phase": "preparing"},
        ],
    }
    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", flow)
    page.wait_for_timeout(100)
    page.locator(".msg-tool-timeline .tool-timeline-summary").first.click()
    page.wait_for_timeout(80)
    expect(page.locator(".tool-timeline-slot-nav span").first.text_content().strip() == "2/2", "patch state: should select second tool before patch")
    page.click("#patch-running")
    page.wait_for_timeout(120)
    details = page.locator(".msg-tool-timeline .tool-timeline-details").first
    expect(not details_hidden(details), "patch state: expanded timeline should remain open after patch")
    expect(page.locator(".tool-timeline-slot-nav span").first.text_content().strip() == "2/2", "patch state: active tool should survive patch")
    expect(page.locator(".msg-tool-timeline .tool-timeline-step.running, .msg-tool-timeline .tool-timeline-step.waiting").count() == 0, "patch state: running step should settle")

    page.locator(".msg-tool-timeline .tool-timeline-summary").first.click()
    page.wait_for_timeout(80)
    expect(details_hidden(details), "patch state: explicit collapse should close timeline")

    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", flow)
    page.wait_for_timeout(100)
    collapsed_details = page.locator(".msg-tool-timeline .tool-timeline-details").first
    expect(details_hidden(collapsed_details), "patch state: explicit collapse should survive component rebuild")
    page.click("#patch-running")
    page.wait_for_timeout(120)
    expect(details_hidden(collapsed_details), "patch state: collapsed timeline should remain collapsed after patch")


def expect_motion_and_view_state(page):
    metrics = page.evaluate("() => window.visualTimelineTest.debugMotionAndViewState()")
    expect(metrics["singleSettleClass"], f"motion/view: single tool completion settle class missing {metrics}")
    expect(metrics["timelineSettleClass"], f"motion/view: timeline completion settle class missing {metrics}")
    expect(metrics["singleRawOpenAfterPatch"], f"motion/view: single raw panel should stay open after patch {metrics}")
    expect(metrics["singleRawButtonExpanded"] == "true", f"motion/view: single raw button aria should stay expanded {metrics}")
    expect(metrics["timelineRawOpenAfterPatch"], f"motion/view: timeline raw panel should stay open after patch {metrics}")
    expect(metrics["timelineRawButtonExpanded"] == "true", f"motion/view: timeline raw button aria should stay expanded {metrics}")
    expect(not metrics["thinkingFreshClass"], f"motion/view: thinking fresh pulse class should stay removed {metrics}")
    expect("思考中" in metrics["thinkingTitle"], f"motion/view: thinking title should show running state {metrics}")


def expect_single_tool_scroll_cases(page):
    long_text = "\n\n".join([
        f"第 {index + 1} 段：用于测试单工具正文滚动，不应该撑开整个对话流。https://example.com/single/{index}"
        for index in range(60)
    ])
    page.evaluate("""(text) => window.visualTimelineTest.renderConversationFlow({
        title: '单工具长正文',
        entries: [
          { type: 'user', _uiKey: 'single-scroll-u1', text: '读取长正文' },
          {
            type: 'tool',
            _uiKey: 'single-scroll-t1',
            toolCallId: 'single-scroll-t1',
            name: 'read_article',
            args: { source: 'auto', tabId: 12, limit: 8000 },
            result: {
              title: '长正文',
              url: 'https://example.com/article',
              text,
              rawRows: Array.from({ length: 80 }, (_, index) => ({
                index: index + 1,
                note: `原始数据滚动验证 ${index + 1}`,
                url: `https://example.com/raw/${index + 1}`
              }))
            }
          }
        ]
    })""", long_text)
    page.wait_for_timeout(100)
    page.locator(".msg-tool > .tool-summary").first.click()
    page.wait_for_timeout(80)
    expect_bounded_article_body(page, ".msg-tool .tool-article-body", "single read_article")
    expect_single_tool_raw_panel_scroll(page, "single read_article")

    long_code = "const payload = '" + ("0123456789abcdef" * 80) + "';\n" + "\n".join([f"console.log(payload.slice({index}, {index + 16}));" for index in range(80)])
    page.evaluate("""(code) => window.visualTimelineTest.renderConversationFlow({
        title: '单工具长代码',
        entries: [
          { type: 'user', _uiKey: 'single-code-u1', text: '运行长脚本' },
          { type: 'tool', _uiKey: 'single-code-t1', toolCallId: 'single-code-t1', name: 'run_script', args: { code }, result: { ok: true, message: 'done' } }
        ]
    })""", long_code)
    page.wait_for_timeout(100)
    page.locator(".msg-tool > .tool-summary").first.click()
    page.wait_for_timeout(80)
    code_metrics = page.locator(".msg-tool .js-code-block").first.evaluate("""(node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        overflowX: getComputedStyle(node).overflowX,
        overflowY: getComputedStyle(node).overflowY,
    })""")
    expect(code_metrics["clientHeight"] <= 380, f"single run_script: code block too tall {code_metrics}")
    expect(code_metrics["scrollHeight"] > code_metrics["clientHeight"], f"single run_script: long code should have vertical overflow {code_metrics}")
    expect(code_metrics["overflowY"] in ("auto", "scroll"), f"single run_script: code block overflowY should scroll {code_metrics}")


def run_edge_case_matrix(page):
    categories = {}
    failures = []

    def record(category, case_id, fn):
        categories[category] = categories.get(category, 0) + 1
        try:
            fn()
        except Exception as exc:
            failures.append({"category": category, "case": case_id, "error": str(exc)})

    def grouped_types(entries):
        grouped = page.evaluate("(items) => window.visualTimelineTest.debugGroupedTranscriptEntries(items)", entries)
        return [item["type"] for item in grouped], grouped

    def tool_entry(key, name="open_tab", run_id="visual-edge-run", result=None, **extra):
        item = {
            "type": "tool",
            "_uiKey": key,
            "toolCallId": key,
            "runId": run_id,
            "name": name,
            "args": (
                {"url": f"https://example.com/{key}"}
                if name in ("open_tab", "navigate")
                else {"source": "auto", "limit": 4000}
                if name == "read_article"
                else {}
            ),
            "result": result if result is not None else {"title": f"页面 {key}", "text": f"正文 {key}"},
        }
        item.update(extra)
        return item

    turn_cases = [
        ("user-only", [{"type": "user", "_uiKey": "edge-u1", "text": "只发用户消息"}], ["user"]),
        ("assistant-preface-only", [{"type": "assistant", "_uiKey": "edge-a1", "content": "先说明"}], ["assistant"]),
        ("empty-assistant-dropped", [{"type": "assistant", "_uiKey": "edge-a-empty", "content": ""}], []),
        ("orphan-streaming-thinking", [{"type": "thinking", "_uiKey": "edge-th1", "text": "", "streaming": True}], ["thinking-group"]),
        ("empty-completed-thinking-dropped", [{"type": "thinking", "_uiKey": "edge-th2", "text": "", "streaming": False}], []),
        ("orphan-single-tool", [tool_entry("edge-t1")], ["tool"]),
        ("single-tool-after-user", [{"type": "user", "_uiKey": "edge-u2", "text": "打开"}, tool_entry("edge-t2"), {"type": "assistant", "_uiKey": "edge-a2", "content": "完成"}], ["user", "tool", "assistant"]),
        ("two-tools-grouped", [{"type": "user", "_uiKey": "edge-u3", "text": "打开读取"}, tool_entry("edge-t3"), tool_entry("edge-t4", "read_article")], ["user", "tool-group"]),
        ("thinking-before-single-tool", [{"type": "user", "_uiKey": "edge-u4", "text": "先想"}, {"type": "thinking", "_uiKey": "edge-th3", "text": "判断边界", "streaming": False}, tool_entry("edge-t5", "read_article")], ["user", "thinking-group", "tool"]),
        ("thinking-tools-reply", [{"type": "user", "_uiKey": "edge-u5", "text": "查证据"}, {"type": "thinking", "_uiKey": "edge-th4", "text": "先查", "streaming": False}, tool_entry("edge-t6"), tool_entry("edge-t7", "read_article"), {"type": "assistant", "_uiKey": "edge-a3", "content": "结论"}], ["user", "thinking-group", "tool-group", "assistant"]),
        ("pure-wait-tool-hidden-in-mixed-turn", [{"type": "user", "_uiKey": "edge-u5b", "text": "查证据"}, tool_entry("edge-t6b"), tool_entry("edge-wait-tool", "wait"), tool_entry("edge-t7b", "read_article")], ["user", "tool-group"]),
        ("only-pure-wait-tools-visible", [{"type": "user", "_uiKey": "edge-u5c", "text": "等一下"}, tool_entry("edge-wait-tool-1", "wait"), tool_entry("edge-wait-tool-2", "wait")], ["user", "tool-group"]),
        ("preface-lanes-reply", [{"type": "user", "_uiKey": "edge-u6", "text": "查一下"}, {"type": "assistant", "_uiKey": "edge-a4", "content": "我先看页面"}, {"type": "thinking", "_uiKey": "edge-th5", "text": "需要正文", "streaming": False}, tool_entry("edge-t8", "read_article"), {"type": "assistant", "_uiKey": "edge-a5", "content": "完成"}], ["user", "assistant", "thinking-group", "tool", "assistant"]),
        ("assistant-splits-later-tool", [{"type": "user", "_uiKey": "edge-u7", "text": "分两段"}, tool_entry("edge-t9"), {"type": "assistant", "_uiKey": "edge-a6", "content": "先看这个"}, tool_entry("edge-t10", "read_article")], ["user", "tool", "assistant", "tool"]),
        ("empty-assistant-still-closes-turn", [{"type": "user", "_uiKey": "edge-u8", "text": "空回复边界"}, tool_entry("edge-t11"), {"type": "assistant", "_uiKey": "edge-a7", "content": ""}, tool_entry("edge-t12", "read_article")], ["user", "tool", "tool"]),
        ("run-id-change-splits", [{"type": "user", "_uiKey": "edge-u9", "text": "两个运行"}, tool_entry("edge-t13", run_id="run-a"), tool_entry("edge-t14", "read_article", run_id="run-b")], ["user", "tool", "tool"]),
        ("same-run-id-groups", [{"type": "user", "_uiKey": "edge-u10", "text": "同运行"}, tool_entry("edge-t15", run_id="run-c"), tool_entry("edge-t16", "read_article", run_id="run-c")], ["user", "tool-group"]),
        ("note-splits-tools", [{"type": "user", "_uiKey": "edge-u11", "text": "note"}, tool_entry("edge-t17"), {"type": "note", "_uiKey": "edge-note", "text": "中间状态"}, tool_entry("edge-t18", "read_article")], ["user", "tool", "note", "tool"]),
        ("wait-splits-tools", [{"type": "user", "_uiKey": "edge-u12", "text": "wait"}, tool_entry("edge-t19"), {"type": "wait", "_uiKey": "edge-wait", "message": "等待"}, tool_entry("edge-t20", "read_article")], ["user", "tool", "wait", "tool"]),
        ("error-splits-tools", [{"type": "user", "_uiKey": "edge-u13", "text": "error"}, tool_entry("edge-t21"), {"type": "error", "_uiKey": "edge-error", "message": "失败"}, tool_entry("edge-t22", "read_article")], ["user", "tool", "error", "tool"]),
        ("new-user-flushes-turn", [{"type": "user", "_uiKey": "edge-u14", "text": "第一轮"}, tool_entry("edge-t23"), {"type": "user", "_uiKey": "edge-u15", "text": "第二轮"}, tool_entry("edge-t24", "read_article")], ["user", "tool", "user", "tool"]),
        ("assistant-then-thinking-new-turn", [{"type": "user", "_uiKey": "edge-u16", "text": "回答后再想"}, tool_entry("edge-t25"), {"type": "assistant", "_uiKey": "edge-a8", "content": "阶段结论"}, {"type": "thinking", "_uiKey": "edge-th6", "text": "继续分析", "streaming": True}], ["user", "tool", "assistant", "thinking-group"]),
    ]

    for case_id, entries, expected in turn_cases:
        def make_turn_check(case_id=case_id, entries=entries, expected=expected):
            types, grouped = grouped_types(entries)
            expect(types == expected, f"{case_id}: expected {expected}, got {types} ({grouped})")
            lane_keys = [item["key"] for item in grouped if item["type"] in ("thinking-group", "tool-group")]
            for key in lane_keys:
                expect(":assistant-turn:" in key, f"{case_id}: lane key should be turn-derived ({key})")
            if case_id == "pure-wait-tool-hidden-in-mixed-turn":
                tool_group = next(item for item in grouped if item["type"] == "tool-group")
                names = [item["name"] for item in tool_group["entries"]]
                expect(names == ["open_tab", "read_article"], f"{case_id}: pure wait should be hidden from mixed aggregation {names}")
            if case_id == "only-pure-wait-tools-visible":
                tool_group = next(item for item in grouped if item["type"] == "tool-group")
                names = [item["name"] for item in tool_group["entries"]]
                expect(names == ["wait", "wait"], f"{case_id}: pure waits should remain visible when they are the only tools {names}")
        record("turn-model", case_id, make_turn_check)

    tool_names = page.evaluate("() => window.visualTimelineTest.allToolNames()")
    for variant in ("empty-result", "error-result"):
        for name in tool_names:
            def make_tool_check(name=name, variant=variant):
                metrics = page.evaluate(
                    "([toolName, variantName]) => window.visualTimelineTest.debugToolVariantCase(toolName, variantName)",
                    [name, variant],
                )
                expect(metrics["hasRoot"], f"{name}/{variant}: root missing {metrics}")
                expect(metrics["hasSummary"] and metrics["summaryText"], f"{name}/{variant}: summary missing {metrics}")
                if metrics["hasDetails"]:
                    expect(metrics["detailsOpen"] and metrics["rootExpanded"], f"{name}/{variant}: expand failed {metrics}")
                expect(metrics["rootWidth"] <= metrics["hostWidth"] + 1, f"{name}/{variant}: root width overflow {metrics}")
                expect(not metrics["hasHorizontalOverflow"], f"{name}/{variant}: horizontal overflow {metrics}")
                expect(metrics["rawPanelOpen"], f"{name}/{variant}: raw panel did not open {metrics}")
                if len(metrics["footerHeights"]) > 1:
                    expect(len(set(metrics["footerHeights"])) == 1, f"{name}/{variant}: footer heights differ {metrics}")
                if variant == "error-result":
                    expect(metrics["hasDetails"], f"{name}/{variant}: error details missing {metrics}")
                    expect(metrics["hasErrorText"], f"{name}/{variant}: error details missing {metrics}")
            record("tool-variants", f"{name}:{variant}", make_tool_check)

    def check_run_script_tab_id_summary_fallback():
        text = page.evaluate("""() => window.visualTimelineTest.debugToolSummaryText({
            name: 'run_script',
            args: { code: 'return document.title;', tabId: 1887129433 },
            result: null
        })""")
        expect("当前页面" in text, f"run_script summary should use current-page fallback, got {text}")
        expect("tabId" not in text and "标签页" not in text and "1887129433" not in text, f"run_script summary leaked tab id: {text}")
    record("tool-summary", "run-script-tabid-fallback", check_run_script_tab_id_summary_fallback)

    def check_run_script_nested_page_title_summary():
        text = page.evaluate("""() => window.visualTimelineTest.debugToolSummaryText({
            name: 'run_script',
            args: { code: 'return rows;', tabId: 1887129433 },
            result: { ok: true, result: { _pageTitle: '订单详情页', _pageUrl: 'https://example.com/order/1', count: 3 } }
        })""")
        expect("订单详情页" in text, f"run_script summary should read nested page title, got {text}")
        expect("tabId" not in text and "标签页" not in text and "1887129433" not in text, f"run_script title summary leaked tab id: {text}")
    record("tool-summary", "run-script-nested-title", check_run_script_nested_page_title_summary)

    def check_plugin_tool_family_grouping():
        expect_plugin_tool_family_grouping(page)
    record("plugin-family", "custom-tool-category-family", check_plugin_tool_family_grouping)

    def check_mcp_plugin_tool_family_grouping():
        expect_mcp_plugin_tool_family_grouping(page)
    record("plugin-family", "mcp-tool-default-family", check_mcp_plugin_tool_family_grouping)

    def check_save_file_content_scroll_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugSaveFileContentScrollState()")
        expect(metrics["hasBlock"], f"save_file content block missing {metrics}")
        expect(metrics["scrollable"], f"save_file content block should scroll internally {metrics}")
        expect(metrics["cappedHeight"], f"save_file content block should stay height-capped {metrics}")
        expect(metrics["overflowY"] in ("auto", "scroll"), f"save_file content block overflow should scroll {metrics}")
        expect(metrics["followsTail"], f"save_file content block should follow tail while at tail {metrics}")
        expect(metrics["staysAfterUserScrollUp"], f"save_file content block should stop following after user scrolls up {metrics}")
        expect(metrics["copyTextLength"] > 1000, f"save_file content copy text should keep full content {metrics}")
    record("tool-scroll", "save-file-content-tail-scroll", check_save_file_content_scroll_state)

    def check_create_skill_content_scroll_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugCreateSkillContentScrollState()")
        expect(metrics["hasBlock"], f"create_skill content preview missing {metrics}")
        expect(metrics["scrollable"], f"create_skill content preview should scroll internally {metrics}")
        expect(metrics["cappedHeight"], f"create_skill content preview should stay height-capped {metrics}")
        expect(metrics["overflowY"] in ("auto", "scroll"), f"create_skill content preview overflow should scroll {metrics}")
        expect(metrics["followsTail"], f"create_skill content preview should follow tail while at tail {metrics}")
        expect(metrics["staysAfterUserScrollUp"], f"create_skill content preview should stop following after user scrolls up {metrics}")
    record("tool-scroll", "create-skill-content-tail-scroll", check_create_skill_content_scroll_state)

    def check_update_skill_diff_scroll_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugUpdateSkillDiffScrollState()")
        expect(metrics["hasBlock"], f"update_skill diff block missing {metrics}")
        expect(metrics["scrollable"], f"update_skill diff block should scroll internally {metrics}")
        expect(metrics["cappedHeight"], f"update_skill diff block should stay height-capped {metrics}")
        expect(metrics["overflowY"] in ("auto", "scroll"), f"update_skill diff block overflow should scroll {metrics}")
        expect(metrics["followsTail"], f"update_skill diff block should follow tail while at tail {metrics}")
        expect(metrics["staysAfterUserScrollUp"], f"update_skill diff block should stop following after user scrolls up {metrics}")
    record("tool-scroll", "update-skill-diff-tail-scroll", check_update_skill_diff_scroll_state)

    def check_nested_scroll_ownership_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugNestedScrollOwnershipState()")
        expect(metrics["hasBlock"] and metrics["scrollable"], f"nested scroll: missing scrollable inner block {metrics}")
        expect(metrics["innerConsumesWheel"], f"nested scroll: inner block should own wheel when it can scroll {metrics}")
        expect(metrics["outerPausedInner"], f"nested scroll: outer wheel should pause inner tail following {metrics}")
        expect(metrics["boundaryReleasesInner"], f"nested scroll: inner boundary should release wheel ownership {metrics}")
        expect(metrics["outsideDoesNotChooseInner"], f"nested scroll: outside preview should not choose inner owner {metrics}")
    record("tool-scroll", "nested-scroll-ownership", check_nested_scroll_ownership_state)

    def check_edit_skill_resource_content_scroll_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugEditSkillResourceContentScrollState()")
        expect(metrics["hasBlock"], f"edit_skill_resource stream: missing preview {metrics}")
        expect(metrics["rootScrollTopStable"], f"edit_skill_resource stream: root scrolled during resource growth {metrics}")
        expect(metrics["rootOverflowVisible"], f"edit_skill_resource stream: root should not be an internal scroll container {metrics}")
        expect(metrics["rootNotInternallyCapped"], f"edit_skill_resource stream: root should not be capped while inner preview is capped {metrics}")
        expect(metrics["blockHeightStable"], f"edit_skill_resource stream: resource preview height should stay stable {metrics}")
        expect(metrics["blockScrollable"], f"edit_skill_resource stream: resource preview should scroll internally {metrics}")
        expect(metrics["blockOverflowScroll"], f"edit_skill_resource stream: resource preview overflow should scroll {metrics}")
        expect(metrics["resourcePathVisible"], f"edit_skill_resource stream: resource path should stay visible {metrics}")
    record("tool-scroll", "edit-skill-resource-content-scroll", check_edit_skill_resource_content_scroll_state)

    def check_timeline_skill_resource_code_scroll_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugTimelineSkillResourceCodeScrollState()")
        expect(metrics["hasBlock"], f"timeline resource code: missing code block {metrics}")
        expect(metrics["cappedHeight"], f"timeline resource code: code block should be height-capped {metrics}")
        expect(metrics["scrollable"], f"timeline resource code: code block should scroll internally {metrics}")
        expect(metrics["overflowY"] in ("auto", "scroll"), f"timeline resource code: overflow should scroll {metrics}")
        expect(metrics["pathVisible"], f"timeline resource code: resource path should remain visible {metrics}")
    record("tool-scroll", "timeline-skill-resource-code-scroll", check_timeline_skill_resource_code_scroll_state)

    def check_timeline_edit_skill_streaming_tail_state():
        metrics = page.evaluate("() => window.visualTimelineTest.debugTimelineEditSkillStreamingTailState()")
        expect(metrics["hasBlock"], f"timeline edit stream: missing diff block {metrics}")
        expect(metrics["scrollable"], f"timeline edit stream: diff block should scroll internally {metrics}")
        expect(metrics["followsTail"], f"timeline edit stream: diff block should follow growing partial args {metrics}")
        expect(metrics["pinnedAfterUserScroll"], f"timeline edit stream: a real user scroll should pause tail following immediately {metrics}")
        expect(metrics["staysAfterUserScrollUp"], f"timeline edit stream: user scroll position should survive patch {metrics}")
        expect(metrics["followTail"] == "false" and metrics["userPinned"] == "true", f"timeline edit stream: pinned state should survive patch {metrics}")
    record("tool-scroll", "timeline-edit-skill-streaming-tail", check_timeline_edit_skill_streaming_tail_state)

    viewport_flow = {
        "title": "edge viewport matrix",
        "entries": [
            {"type": "user", "_uiKey": "edge-vp-u1", "text": "窄屏 lane 宽度"},
            {"type": "thinking", "_uiKey": "edge-vp-th1", "text": "最新的思考尾部内容需要在窄屏保持单行预览。", "streaming": False},
            {"type": "tool", "_uiKey": "edge-vp-single", "toolCallId": "edge-vp-single", "name": "read_article", "args": {"source": "auto", "tabId": 1887, "limit": 4000}, "result": {"title": "正文", "text": "短正文"}},
            {"type": "assistant", "_uiKey": "edge-vp-a1", "content": "单工具完成"},
            {"type": "tool", "_uiKey": "edge-vp-t1", "toolCallId": "edge-vp-t1", "name": "open_tab", "args": {"url": "https://example.com/a"}, "result": {"title": "页面 A"}},
            {"type": "tool", "_uiKey": "edge-vp-t2", "toolCallId": "edge-vp-t2", "name": "read_article", "args": {"source": "auto", "limit": 4000}, "result": {"title": "页面 A", "text": "正文 A"}},
        ],
    }
    for width in (280, 300, 320, 360, 375, 390, 420, 520, 760, 900):
        def make_viewport_check(width=width):
            page.evaluate("(value) => window.visualTimelineTest.setDeviceWidth(value)", width)
            page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", viewport_flow)
            page.wait_for_timeout(60)
            metrics = page.evaluate("""() => {
                const rectWidth = (selector) => {
                  const node = document.querySelector(selector);
                  return node ? Math.round(node.getBoundingClientRect().width) : 0;
                };
                const device = document.querySelector('.visual-device');
                return {
                  thinking: rectWidth('.msg-thinking-group'),
                  singleTool: rectWidth('.msg-tool'),
                  toolGroup: rectWidth('.msg-tool-timeline'),
                  deviceClient: device?.clientWidth || 0,
                  deviceScroll: device?.scrollWidth || 0,
                };
            }""")
            lane_widths = [metrics["thinking"], metrics["singleTool"], metrics["toolGroup"]]
            expect(all(value > 0 for value in lane_widths), f"viewport {width}: missing lane {metrics}")
            expect(max(lane_widths) - min(lane_widths) <= 1, f"viewport {width}: lane widths differ {metrics}")
            expect(metrics["deviceScroll"] <= metrics["deviceClient"] + 1, f"viewport {width}: horizontal overflow {metrics}")
        record("viewport-width", f"width:{width}", make_viewport_check)

    def check_preview_identity():
        metrics = page.evaluate("() => window.visualTimelineTest.debugPatchThinkingPreviewScroller()")
        expect(metrics["sameNode"] == [True, True], f"thinking preview identity failed {metrics}")
        expect(metrics["sameTrack"] == [True, True], f"thinking preview track identity failed {metrics}")
    record("streaming-patch", "thinking-preview-node-stability", check_preview_identity)

    def check_preview_structure():
        metrics = page.evaluate("() => window.visualTimelineTest.debugPatchThinkingPreviewScroller()")
        expect(metrics["bufferCount"] == 0, f"thinking preview should not use buffer {metrics}")
        expect(metrics["trackCount"] == 1, f"thinking preview should use one track {metrics}")
    record("streaming-patch", "thinking-preview-single-track", check_preview_structure)

    def check_preview_tail():
        metrics = page.evaluate("() => window.visualTimelineTest.debugPatchThinkingPreviewScroller()")
        expect(all(item["left"] > 0 for item in metrics["scrollTrace"]), f"thinking preview should stay near tail {metrics}")
        expect("尾部三" in metrics["text"], f"thinking preview latest tail missing {metrics}")
    record("streaming-patch", "thinking-preview-tail", check_preview_tail)

    def check_single_tool_collapse_after_patch():
        metrics = page.evaluate("() => window.visualTimelineTest.debugPatchSingleToolCollapse()")
        expect(metrics["hasCollapse"], f"single tool collapse missing {metrics}")
        expect(metrics["hidden"], f"single tool collapse did not hide details {metrics}")
        expect(metrics["expanded"] == "false", f"single tool aria not collapsed {metrics}")
    record("streaming-patch", "single-tool-collapse-after-patch", check_single_tool_collapse_after_patch)

    def check_timeline_nav_stability_after_patch():
        metrics = page.evaluate("() => window.visualTimelineTest.debugToolTimelineNavPatchStability()")
        expect(metrics["hasFamilyRows"], f"timeline nav patch: missing family chips {metrics}")
        expect(metrics["navSameNode"], f"timeline nav patch: nav area should survive streaming patch {metrics}")
        expect(metrics["rowSameNode"], f"timeline nav patch: family row should survive streaming patch {metrics}")
        expect(metrics["batchSameNode"], f"timeline nav patch: family batch should survive streaming patch {metrics}")
        expect(metrics["clickedPreservedRow"], f"timeline nav patch: preserved row disconnected before click {metrics}")
        expect(metrics["targetFamilyActive"], f"timeline nav patch: preserved family chip click did not activate panel {metrics}")
    record("streaming-patch", "timeline-nav-chip-stability", check_timeline_nav_stability_after_patch)

    def check_timeline_sticky_chrome_covers_tables():
        metrics = page.evaluate("() => window.visualTimelineTest.debugToolTimelineStickyChromeCoversTables()")
        expect(metrics["hasTable"], f"timeline sticky chrome: missing table {metrics}")
        expect(metrics["tableWrapScrollable"], f"timeline sticky chrome: table should be scrollable {metrics}")
        expect(metrics["summaryTopInsideSummary"], f"timeline sticky chrome: summary not topmost {metrics}")
        expect(metrics["navTopInsideNav"], f"timeline sticky chrome: nav/chips not topmost {metrics}")
        expect(not metrics["summaryTopIsTable"], f"timeline sticky chrome: table bled into summary {metrics}")
        expect(not metrics["navTopIsTable"], f"timeline sticky chrome: table bled into nav/chips {metrics}")
    record("streaming-patch", "timeline-sticky-chrome-covers-tables", check_timeline_sticky_chrome_covers_tables)

    def check_thinking_open_survives_replacement():
        metrics = page.evaluate("() => window.visualTimelineTest.debugThinkingOpenSurvivesReplacement()")
        expect(metrics["afterClick"]["expanded"], f"thinking replacement: initial click did not expand {metrics}")
        expect(metrics["afterClick"]["userToggled"], f"thinking replacement: click did not mark user state {metrics}")
        expect(metrics["afterReplace"]["expanded"], f"thinking replacement: rebuilt node lost expanded state {metrics}")
        expect(metrics["afterReplace"]["userToggled"], f"thinking replacement: rebuilt node lost user state {metrics}")
        expect(metrics["afterPatch"]["expanded"], f"thinking replacement: patch after rebuild collapsed the lane {metrics}")
        expect("patch 更新" in metrics["afterPatch"]["body"], f"thinking replacement: latest body missing {metrics}")
    record("streaming-patch", "thinking-open-survives-replacement", check_thinking_open_survives_replacement)

    expected_categories = {
        "turn-model": 22,
        "tool-variants": len(tool_names) * 2,
        "tool-summary": 2,
        "plugin-family": 2,
        "tool-scroll": 7,
        "viewport-width": 10,
        "streaming-patch": 7,
    }
    total = sum(categories.values())
    expect(categories == expected_categories, f"edge-case matrix categories changed, got {categories}")
    if failures:
        raise AssertionError("edge-case matrix failures: " + json.dumps(failures, ensure_ascii=False))
    return {
        "scenario": "edge-cases",
        "cases": total,
        "categories": categories,
    }


def run_all_tool_component_checks(page):
    page.evaluate("() => window.visualTimelineTest.renderAllToolComponents({ expanded: false })")
    page.wait_for_selector(".visual-tool-component")
    page.wait_for_timeout(160)

    tool_names = page.evaluate("() => window.visualTimelineTest.allToolNames()")
    expect(isinstance(tool_names, list) and tool_names, "all-tools: missing tool name registry")
    component_count = page.locator(".visual-tool-component").count()
    expect(component_count == len(tool_names), f"all-tools: expected {len(tool_names)} components, got {component_count}")

    failures = []
    raw_tools = []
    tree_tools = []
    copy_tools = []
    for name in tool_names:
        try:
            stats = check_tool_component(page, name)
            if stats["rawDetails"]:
                raw_tools.append(name)
            if stats["treeToggles"]:
                tree_tools.append(name)
            if stats["copyButtons"]:
                copy_tools.append(name)
        except Exception as exc:
            failures.append({"tool": name, "error": str(exc)})

    if failures:
        raise AssertionError("all-tools component failures: " + json.dumps(failures, ensure_ascii=False))

    patched_collapse = page.evaluate("() => window.visualTimelineTest.debugPatchSingleToolCollapse()")
    expect(patched_collapse["hasCollapse"], f"single-tool patch collapse: missing collapse button {patched_collapse}")
    expect(patched_collapse["hidden"], f"single-tool patch collapse: collapse button did not hide details {patched_collapse}")
    expect(patched_collapse["expanded"] == "false", f"single-tool patch collapse: aria-expanded should be false {patched_collapse}")
    expect("tool-expanded" not in patched_collapse["rootClass"], f"single-tool patch collapse: root should leave expanded state {patched_collapse}")

    expect("scroll-overflow" not in page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1 ? 'scroll-overflow' : ''"), "all-tools: horizontal page overflow")
    return {
        "scenario": "all-tools",
        "components": component_count,
        "rawDetailsTested": len(raw_tools),
        "treeToolsTested": tree_tools,
        "copyToolsTested": copy_tools,
        "tables": page.locator(".tool-data-table").count(),
        "codeBlocks": page.locator(".js-code-block, .json-block").count(),
    }


def check_tool_component(page, name):
    selector = f'.visual-tool-component[data-tool-name="{name}"]'
    card = page.locator(selector)
    expect(card.count() == 1, f"{name}: component missing")
    summary = card.locator(".tool-summary").first
    details = card.locator(".tool-details").first
    expect(summary.count() == 1, f"{name}: summary missing")
    expect(details.count() == 1, f"{name}: details missing")
    tool_event = card.locator(".msg-tool").first

    # expand, collapse, expand again: this covers the shared disclosure behavior.
    if not details_hidden(details):
        collapse = card.locator(".tool-event-collapse-btn").first
        if collapse.count():
            collapse.click()
        else:
            summary.click()
        page.wait_for_timeout(35)
    expect(details_hidden(details), f"{name}: expected initial collapsed state")
    collapsed_header_height = rounded_height(summary)
    summary.click()
    page.wait_for_timeout(45)
    expect(not details_hidden(details), f"{name}: expand failed")
    expect(summary.get_attribute("aria-expanded") == "true", f"{name}: aria-expanded not true after expand")
    expect("tool-expanded" in (tool_event.get_attribute("class") or ""), f"{name}: expanded tool should be one card")
    expect(abs(rounded_height(summary) - collapsed_header_height) <= 1, f"{name}: expanded header height should match collapsed")
    if summary.locator(".tool-args-preview").count():
        expect(not summary.locator(".tool-args-preview").first.is_visible(), f"{name}: expanded summary preview should be hidden")
    expect(card.locator(".tool-event-footer").count() == 1, f"{name}: missing single-tool footer")
    card.locator(".tool-event-collapse-btn").first.click()
    page.wait_for_timeout(45)
    expect(details_hidden(details), f"{name}: collapse failed")
    expect(summary.get_attribute("aria-expanded") == "false", f"{name}: aria-expanded not false after collapse")
    expect("tool-expanded" not in (tool_event.get_attribute("class") or ""), f"{name}: collapsed tool should leave expanded card state")
    summary.click()
    page.wait_for_timeout(45)
    expect(not details_hidden(details), f"{name}: second expand failed")

    if name == "read_article":
        expect_bounded_article_body(page, f'{selector} .tool-article-body', name)
        outline_titles = card.locator(".tool-slim-title").evaluate_all("""
          (nodes) => nodes
            .filter(node => {
              const style = getComputedStyle(node);
              return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(node => node.textContent.trim())
        """)
        expect(not any("目录" in title for title in outline_titles), f"{name}: article outline should stay out of preview {outline_titles}")
        visible_heading_badges = card.locator(".tool-slim-meta span").evaluate_all("""
          (nodes) => nodes
            .filter(node => {
              const style = getComputedStyle(node);
              return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(node => node.textContent.trim())
        """)
        expect(not any(text in ("H1", "H2", "H3") for text in visible_heading_badges), f"{name}: heading level badges should stay out of preview {visible_heading_badges}")
    if name == "manage_sessions":
        summary_text = summary.text_content()
        expect("prompt" in summary_text and "竞品" in summary_text, "manage_sessions: summary should expose subtask prompt")
        expect(card.locator(".tool-session-prompt").count() == 1, "manage_sessions: missing subtask prompt block")
        expect("只做信息采集" in card.locator(".tool-session-prompt").first.text_content(), "manage_sessions: prompt block missing prompt text")
    if name == "create_skill":
        summary_text = summary.text_content()
        expect("字正文" in summary_text, "create_skill: summary should expose compact content metrics")
        expect("content=" not in summary_text and "resources=" not in summary_text, "create_skill: summary should not expose raw long args")
        expect(card.locator(".tool-skill-content-preview").count() == 1, "create_skill: missing bounded skill content preview")
        expect("保存中展示正文预览" in card.locator(".tool-skill-content-preview").first.text_content(), "create_skill: content preview missing body text")
    if name == "edit_skill_resource":
        summary_text = summary.text_content()
        expect("scripts/check-publish.js" in summary_text, "edit_skill_resource: summary should expose resource path")
        expect("content=" not in summary_text, "edit_skill_resource: summary should not expose raw content args")
        expect(card.locator(".tool-skill-resource-section").count() == 1, "edit_skill_resource: missing resource section")
        expect(card.locator(".tool-skill-resource-code").count() == 1, "edit_skill_resource: missing resource code block")
    if name == "load_skill_resource":
        text = card.text_content() or ""
        expect("references/publish-checklist.md" in text, "load_skill_resource: missing resource path")
        expect("发布检查参考资料" in text, "load_skill_resource: missing resource description")
        expect(card.locator(".tool-skill-resource-section").count() == 1, "load_skill_resource: missing custom resource section")
        expect(card.locator(".tool-skill-resource-code").count() == 1, "load_skill_resource: missing highlighted resource code block")
        expect(card.locator(".tool-skill-resource-section .copyable-code-block").count() == 1, "load_skill_resource: missing copyable code wrapper")
        expect(card.locator(".tool-skill-resource-code.hljs").count() == 1, "load_skill_resource: code block should use highlighter classes")
        expect("检查正文换行是否保留" in text, "load_skill_resource: missing resource content")
    if name == "update_skill":
        summary_text = summary.text_content()
        expect("处变更" in summary_text, "update_skill: summary should expose compact change count")
        expect("appendContent" not in summary_text and "resourceEdits" not in summary_text, "update_skill: summary should not expose raw long args")
        expect(card.locator(".tool-diff-card").count() >= 3, "update_skill: missing append/edit/resource change cards")
        expect("追加" in card.locator(".tool-diff-section").first.text_content(), "update_skill: append change title missing")
        expect("富文本粘贴" in card.locator(".tool-diff-section").first.text_content(), "update_skill: edit content missing")
        expect("scripts/check-publish.js" in card.locator(".tool-diff-section").first.text_content(), "update_skill: resource edit missing")
    if name == "inspect_element":
        text = card.text_content() or ""
        expect(card.locator(".tool-compact-line").count() >= 1, "inspect_element: missing readiness summary")
        expect("visible true" in text and "viewport true" in text and "可点击" in text, "inspect_element: missing element readiness evidence")
        expect(card.locator(".tool-kv-grid").count() == 0, "inspect_element: should not use heavy key-value grid")
        expect("button.publish" in text and "可点击点" in text, "inspect_element: missing slim context evidence")
        expect("附近文本" not in text, "inspect_element: nearby text field should not render")
    if name == "act_on_element":
        text = card.text_content() or ""
        expect("保存草稿" in text, "act_on_element: missing clicked target")
        expect("method cdp" in text and "navigated false" in text and "new tab false" in text, "act_on_element: missing action receipt")
        expect("结果证据" not in text and "点击命中目标元素" not in text, "act_on_element: redundant result evidence leaked")
    if name == "network_body":
        text = card.text_content() or ""
        expect("POST /api/search · 200" in text, "network_body: missing request headline")
        expect("响应体" in text and '"items"' in text, "network_body: missing response body evidence")
        expect("request req_42" in text and "1280ms" in text, "network_body: missing request metadata")
        directions = page.evaluate("() => window.visualTimelineTest.debugNetworkBodyTypeState()")
        expect("读取请求体" in directions["requestText"], f"network_body: request summary label missing {directions}")
        expect("请求体" in directions["requestText"] and "轻舟工具" in directions["requestText"], f"network_body: request body evidence missing {directions}")
        expect("读取响应体" in directions["responseText"], f"network_body: response summary label regressed {directions}")
        expect("响应体" in directions["responseText"] and '"ok"' in directions["responseText"], f"network_body: response body evidence regressed {directions}")
    if name == "wait_for_user":
        text = card.text_content() or ""
        expect("登录验证完成" in text or "用户操作完成" in text, "wait_for_user: missing compact completion title")
        expect("要求用户做什么" in text and "完成手机号验证" in text, "wait_for_user: missing manual-step request")
        expect("恢复后观察" in text, "wait_for_user: missing resume observation")
    if name == "load_skill":
        text = card.text_content() or ""
        expect("SKILL.md" in text and "scripts/publish.js" in text, "load_skill: missing resource list")
        expect("markdown" in text and "script" in text, "load_skill: missing resource profile")
    if name == "delete_skill":
        text = card.text_content() or ""
        expect(card.locator(".tool-danger-result").count() == 1, "delete_skill: missing muted deletion receipt")
        expect("已删除 skill" in text and "xiaohongshu-note-publisher" in text, "delete_skill: missing delete summary")
    if name == "ask_llm":
        text = card.text_content() or ""
        expect("Prompt" in text and "结果" in text, "ask_llm: missing prompt/result sections")
        expect("提取页面" in text and "城市特色明确" in text, "ask_llm: missing useful prompt/result content")
    if name == "group_tabs":
        text = card.text_content() or ""
        expect("已整理到「轻舟任务」" in text and "绿色分组" in text and "3 个标签页" in text, "group_tabs: missing group summary")
        expect("发布编辑页" in text and "素材表" in text, "group_tabs: missing tab list")
    if name == "document_read_chunk":
        text = card.text_content() or ""
        expect("正文块 2 / 8" in text and "竞品报告" in text, "document_read_chunk: missing text chunk headline")
        expect("候选品牌的定位" in text, "document_read_chunk: missing text chunk preview")

    copy_count = 0
    raw_count = card.locator(".tool-event-raw-btn:not(.hidden)").count()
    if raw_count:
        footer_heights = card.locator(".tool-event-footer-row").first.evaluate("""(node) => {
            const items = [...node.querySelectorAll('.tool-event-raw-btn:not(.hidden), .tool-event-collapse-btn')];
            return items.map(item => Math.round(item.getBoundingClientRect().height));
        }""")
        expect(len(set(footer_heights)) <= 1, f"{name}: single-tool footer actions should have equal height {footer_heights}")
        raw_button = card.locator(".tool-event-raw-btn").first
        raw_panel = card.locator(".tool-event-raw-panel").first
        raw_button.click()
        page.wait_for_timeout(35)
        expect("hidden" not in (raw_panel.get_attribute("class") or ""), f"{name}: raw panel did not open")
        expect(raw_panel.locator("summary").count() == 0, f"{name}: raw panel should not expose native details summary")
        raw_width = raw_panel.locator(".copyable-code-block").first.evaluate("(node) => node.getBoundingClientRect().width")
        details_width = details.evaluate("(node) => node.getBoundingClientRect().width")
        expect(raw_width >= details_width - 24, f"{name}: raw panel should span details width ({raw_width} < {details_width})")
        copy_count += click_visible_copy_button(page, raw_panel, name)
        raw_button.click()
        page.wait_for_timeout(35)
        expect("hidden" in (raw_panel.get_attribute("class") or ""), f"{name}: raw panel did not close")

    tree_count = card.locator(".tool-tree-toggle").count()
    if tree_count:
        expect_tree_header_layout(card, name)
        toggle = card.locator(".tool-tree-toggle").first
        expect(toggle.get_attribute("aria-expanded") == "true", f"{name}: tree toggle initial aria mismatch")
        toggle.click()
        page.wait_for_timeout(45)
        expect(toggle.get_attribute("aria-expanded") == "false", f"{name}: tree collapse failed")
        expect(card.locator(".tool-tree-line-hidden").count() >= 1, f"{name}: collapsed tree did not hide child rows")
        toggle.click()
        page.wait_for_timeout(45)
        expect(toggle.get_attribute("aria-expanded") == "true", f"{name}: tree expand failed")
        if name == "get_ax_tree":
            depths = card.locator(".tool-tree-line").evaluate_all("(nodes) => nodes.map(node => Number(node.dataset.depth || 0))")
            expect(max(depths or [0]) > 0, "get_ax_tree: tree view should preserve hierarchy instead of rendering flat actions")
            expect("可操作元素" in (card.text_content() or ""), "get_ax_tree: actions should render as a separate action summary")
            expect(card.locator(".tool-ax-actions-table .tool-data-table").count() == 1, "get_ax_tree: actions should render as a compact table")
            expect(card.locator(".tool-ax-actions-table .tool-slim-row").count() == 0, "get_ax_tree: actions should not render as tall slim rows")

    copy_count += click_visible_copy_button(page, card, name)
    scroll_overflow = card.evaluate("(node) => node.scrollWidth > node.clientWidth + 1")
    expect(not scroll_overflow, f"{name}: component has horizontal overflow")

    return {
        "rawDetails": raw_count,
        "treeToggles": tree_count,
        "copyButtons": copy_count,
    }


def expect_tree_header_layout(card, name):
    tree_url = card.locator(".tool-tree-url").first
    tree_stats = card.locator(".tool-tree-stats").first
    expect(tree_url.count() == 1, f"{name}: tree url should render as a dedicated block")
    expect(tree_stats.count() == 1, f"{name}: tree stats should render as compact text")
    metrics = tree_url.evaluate("""(node) => {
        const own = node.getBoundingClientRect();
        const panel = node.closest('.tool-tree-panel')?.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
            width: own.width,
            panelWidth: panel?.width || 0,
            radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            text: node.textContent.trim(),
        };
    }""")
    expect(metrics["width"] <= metrics["panelWidth"] + 1, f"{name}: tree url should not overflow panel ({metrics})")
    expect(metrics["radius"] <= 8, f"{name}: tree url should use a squarer radius ({metrics})")
    expect(metrics["whiteSpace"] == "normal", f"{name}: tree url should allow wrapping ({metrics})")
    expect(metrics["overflowWrap"] in ("anywhere", "break-word"), f"{name}: tree url should wrap long tokens ({metrics})")
    stats_text = tree_stats.text_content() or ""
    expect("深度" in stats_text and "节点" in stats_text and "展示" in stats_text, f"{name}: tree stats should be readable ({stats_text})")
    expect("语义" not in stats_text, f"{name}: tree stats should omit semantic count ({stats_text})")


def details_hidden(locator):
    return "hidden" in (locator.get_attribute("class") or "").split()


def rounded_height(locator):
    return round(locator.evaluate("(node) => node.getBoundingClientRect().height"))


def expect_bounded_article_body(page, selector, label):
    article = page.locator(selector)
    expect(article.count() >= 1, f"{label}: missing article body")
    metrics = article.first.evaluate("""(node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        overflowY: getComputedStyle(node).overflowY
    })""")
    expect(metrics["clientHeight"] <= 340, f"{label}: article body too tall ({metrics['clientHeight']}px)")
    expect(metrics["scrollHeight"] > metrics["clientHeight"], f"{label}: article body should scroll")
    expect(metrics["overflowY"] in ("auto", "scroll"), f"{label}: article body overflow is {metrics['overflowY']}")


def expect_timeline_raw_panel_scroll(page, label):
    raw_button = page.locator(".msg-tool-timeline .tool-timeline-raw-btn:not(.hidden)").first
    expect(raw_button.count() == 1, f"{label}: missing timeline raw button")
    raw_button.click()
    page.wait_for_timeout(60)
    raw_panel = page.locator(".msg-tool-timeline .tool-timeline-raw-panel:not(.hidden)").first
    expect(raw_panel.count() == 1, f"{label}: timeline raw panel did not open")
    raw_pre = raw_panel.locator(".copyable-code-block pre").first
    expect(raw_pre.count() == 1, f"{label}: timeline raw panel missing code block")
    metrics = raw_pre.evaluate("""(node) => {
        node.scrollTop = 0;
        const before = node.scrollTop;
        node.scrollTop = 160;
        return {
            before,
            after: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            overscrollBehaviorY: getComputedStyle(node).overscrollBehaviorY,
        };
    }""")
    expect(metrics["clientHeight"] <= 380, f"{label}: raw panel too tall ({metrics})")
    expect(metrics["scrollHeight"] > metrics["clientHeight"], f"{label}: raw panel should have vertical overflow ({metrics})")
    expect(metrics["overflowY"] in ("auto", "scroll"), f"{label}: raw panel overflow is not scrollable ({metrics})")
    expect(metrics["after"] > metrics["before"], f"{label}: raw panel scrollTop did not move ({metrics})")
    expect(metrics["overscrollBehaviorY"] == "contain", f"{label}: raw panel should contain wheel chaining ({metrics})")
    raw_button.click()
    page.wait_for_timeout(40)


def expect_single_tool_raw_panel_scroll(page, label):
    raw_button = page.locator(".msg-tool .tool-event-raw-btn:not(.hidden)").first
    expect(raw_button.count() == 1, f"{label}: missing single-tool raw button")
    raw_button.click()
    page.wait_for_timeout(60)
    raw_panel = page.locator(".msg-tool .tool-event-raw-panel:not(.hidden)").first
    expect(raw_panel.count() == 1, f"{label}: single-tool raw panel did not open")
    raw_pre = raw_panel.locator(".copyable-code-block pre").first
    expect(raw_pre.count() == 1, f"{label}: single-tool raw panel missing code block")
    metrics = raw_pre.evaluate("""(node) => {
        node.scrollTop = 0;
        const before = node.scrollTop;
        node.scrollTop = 160;
        return {
            before,
            after: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            overscrollBehaviorY: getComputedStyle(node).overscrollBehaviorY,
        };
    }""")
    expect(metrics["clientHeight"] <= 380, f"{label}: single-tool raw panel too tall ({metrics})")
    expect(metrics["scrollHeight"] > metrics["clientHeight"], f"{label}: single-tool raw panel should have overflow ({metrics})")
    expect(metrics["overflowY"] in ("auto", "scroll"), f"{label}: single-tool raw panel overflow is not scrollable ({metrics})")
    expect(metrics["after"] > metrics["before"], f"{label}: single-tool raw panel scrollTop did not move ({metrics})")
    expect(metrics["overscrollBehaviorY"] == "contain", f"{label}: single-tool raw panel should contain wheel chaining ({metrics})")
    raw_button.click()
    page.wait_for_timeout(40)


def expect_family_aware_navigation(page):
    initial_nav = tool_nav_button_positions(page)
    # From a non-latest collect batch, next should stay inside the collect family.
    page.locator('.tool-timeline-nav-btn[data-timeline-nav-direction="1"]').click()
    page.wait_for_timeout(80)
    expect_tool_nav_positions_equal(initial_nav, tool_nav_button_positions(page), "long: same-family navigation")
    active_family = page.evaluate("() => document.querySelector('.tool-family-row.active')?.dataset.toolFamilyId || ''")
    expect(active_family == "collect", f"long: next inside collect family moved to {active_family}")

    # From the collect family tab itself (latest collect item), next should cross into the next family.
    page.locator('.tool-family-row[data-tool-family-id="collect"]').click()
    page.wait_for_timeout(80)
    boundary_nav = tool_nav_button_positions(page)
    page.locator('.tool-timeline-nav-btn[data-timeline-nav-direction="1"]').click()
    page.wait_for_timeout(80)
    expect_tool_nav_positions_equal(boundary_nav, tool_nav_button_positions(page), "long: cross-family navigation")
    next_family = page.evaluate("() => document.querySelector('.tool-family-row.active')?.dataset.toolFamilyId || ''")
    expect(next_family and next_family != "collect", f"long: next at collect boundary did not move family ({next_family})")


def tool_nav_button_positions(page):
    return page.evaluate("""() => {
        const nav = document.querySelector('.tool-timeline-slot-nav');
        const card = nav?.closest('.msg-tool-timeline');
        const cardRect = card?.getBoundingClientRect();
        return {
          buttons: [...(nav?.querySelectorAll('.tool-timeline-nav-btn') || [])].map((button) => {
            const rect = button.getBoundingClientRect();
            return { direction: button.dataset.timelineNavDirection, left: rect.left, top: rect.top };
          }),
          card: cardRect ? { left: cardRect.left, width: cardRect.width } : null,
          messagesWidth: document.querySelector('#messages')?.clientWidth || 0,
        };
    }""")


def expect_tool_nav_positions_equal(before, after, label):
    expect(len(before["buttons"]) == 2 and len(after["buttons"]) == 2, f"{label}: expected two pager buttons ({before}, {after})")
    for previous, current in zip(before["buttons"], after["buttons"]):
        expect(previous["direction"] == current["direction"], f"{label}: pager order changed ({before}, {after})")
        expect(abs(previous["left"] - current["left"]) <= 1, f"{label}: pager moved horizontally ({before}, {after})")
        expect(abs(previous["top"] - current["top"]) <= 1, f"{label}: pager moved vertically ({before}, {after})")
    expect(before["card"] is not None and after["card"] is not None, f"{label}: missing timeline card geometry")
    expect(abs(before["card"]["left"] - after["card"]["left"]) <= 1, f"{label}: timeline card moved ({before}, {after})")
    expect(abs(before["card"]["width"] - after["card"]["width"]) <= 1, f"{label}: timeline card width changed ({before}, {after})")
    expect(before["messagesWidth"] == after["messagesWidth"], f"{label}: chat lane width changed ({before}, {after})")


def expect_shared_timeline_pager_geometry(page, label):
    metrics = page.evaluate("""() => [...document.querySelectorAll('.timeline-pager')]
      .filter((node) => node.getClientRects().length)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('.timeline-pager-btn')].map((button) => button.getBoundingClientRect());
        const counter = node.querySelector(':scope > span')?.getBoundingClientRect();
        return {
          classes: node.className,
          width: rect.width,
          buttonWidths: buttons.map((button) => button.width),
          leftGap: buttons[0] && counter ? counter.left - buttons[0].right : -1,
          rightGap: buttons[1] && counter ? buttons[1].left - counter.right : -1,
        };
      })""")
    expect(metrics, f"{label}: missing visible timeline pager")
    for metric in metrics:
        expect(abs(metric["width"] - 82) <= 1, f"{label}: pager width differs from shared geometry ({metrics})")
        expect(len(metric["buttonWidths"]) == 2 and all(abs(width - 22) <= 1 for width in metric["buttonWidths"]), f"{label}: pager button size differs ({metrics})")
        expect(abs(metric["leftGap"] - 4) <= 1 and abs(metric["rightGap"] - 4) <= 1, f"{label}: pager spacing differs ({metrics})")


def expect_chat_lane_widths(page, label):
    metrics = page.evaluate("""() => [...document.querySelectorAll('.msg[data-chat-lane]')]
      .filter((node) => node.getClientRects().length)
      .map((node) => {
        const lane = node.dataset.chatLane || '';
        const parent = node.parentElement;
        const parentStyle = parent ? getComputedStyle(parent) : null;
        const available = parent
          ? parent.clientWidth
            - (Number.parseFloat(parentStyle.paddingLeft) || 0)
            - (Number.parseFloat(parentStyle.paddingRight) || 0)
          : 0;
        const cap = lane === 'summary' ? 520 : lane === 'detail' ? 820 : available;
        return {
          lane,
          classes: node.className,
          width: node.getBoundingClientRect().width,
          expected: Math.min(available, cap),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      })""")
    expect(metrics, f"{label}: no semantic chat lanes rendered")
    for metric in metrics:
        expect(metric["lane"] in ("summary", "detail", "wide"), f"{label}: unknown lane state ({metric})")
        expect(abs(metric["width"] - metric["expected"]) <= 1.5, f"{label}: lane width escaped the three-tier model ({metric})")
        expect(metric["scrollWidth"] <= metric["clientWidth"] + 1, f"{label}: lane content widened its outer card ({metric})")


def expect_regular_tool_nav_positions_stable(page, details, label):
    nav = details.locator(".tool-timeline-slot-nav")
    before = nav.evaluate("""(node) => {
        const cardRect = node.closest('.msg-tool-timeline')?.getBoundingClientRect();
        return {
          buttons: [...node.querySelectorAll('.tool-timeline-nav-btn')].map((button) => {
            const rect = button.getBoundingClientRect();
            return { direction: button.dataset.timelineNavDirection, left: rect.left, top: rect.top };
          }),
          card: cardRect ? { left: cardRect.left, width: cardRect.width } : null,
          messagesWidth: document.querySelector('#messages')?.clientWidth || 0,
        };
    }""")
    next_button = nav.locator('.tool-timeline-nav-btn[data-timeline-nav-direction="1"]')
    previous_button = nav.locator('.tool-timeline-nav-btn[data-timeline-nav-direction="-1"]')
    button = next_button if next_button.is_enabled() else previous_button
    expect(button.is_enabled(), f"{label}: no enabled pager button")
    button.click()
    page.wait_for_timeout(80)
    after = nav.evaluate("""(node) => {
        const cardRect = node.closest('.msg-tool-timeline')?.getBoundingClientRect();
        return {
          buttons: [...node.querySelectorAll('.tool-timeline-nav-btn')].map((item) => {
            const rect = item.getBoundingClientRect();
            return { direction: item.dataset.timelineNavDirection, left: rect.left, top: rect.top };
          }),
          card: cardRect ? { left: cardRect.left, width: cardRect.width } : null,
          messagesWidth: document.querySelector('#messages')?.clientWidth || 0,
        };
    }""")
    expect_tool_nav_positions_equal(before, after, f"{label}: regular navigation")


def expect_tool_slot_nav_family_scoped(page, label):
    metrics = page.evaluate("""() => {
        const nav = document.querySelector('.tool-timeline-slot-nav span');
        const activeFamily = document.querySelector('.tool-family-row.active');
        if (!nav || !activeFamily) return null;
        const match = (nav.textContent || '').trim().match(/^(\\d+)\\/(\\d+)$/);
        const count = Number(activeFamily.querySelector('.tool-family-count')?.textContent?.trim());
        return {
            text: (nav.textContent || '').trim(),
            scope: nav.dataset.positionScope || '',
            current: match ? Number(match[1]) : 0,
            total: match ? Number(match[2]) : 0,
            familyId: activeFamily.dataset.toolFamilyId || '',
            familyCount: count,
        };
    }""")
    expect(metrics is not None, f"{label}: missing family-scoped nav metrics")
    expect(metrics["scope"] == "family", f"{label}: nav scope should be family ({metrics})")
    expect(metrics["familyCount"] > 0, f"{label}: active family count missing ({metrics})")
    expect(metrics["total"] == metrics["familyCount"], f"{label}: nav total should match active family ({metrics})")
    expect(1 <= metrics["current"] <= metrics["total"], f"{label}: nav current out of range ({metrics})")


def expect_tool_family_menu_has_stable_pager(page, label):
    metrics = page.evaluate("""() => {
        const submenu = document.querySelector('.tool-family-submenu');
        const panels = submenu?.querySelector(':scope > .tool-family-panels');
        const navHost = submenu?.querySelector(':scope > .tool-family-panel-nav');
        const nav = navHost?.querySelector('.tool-timeline-slot-nav');
        const primary = panels?.querySelector('.tool-family-panel.active .tool-family-primary-batch');
        const batch = primary?.querySelector('.tool-family-batch');
        const remaining = panels?.querySelector('.tool-family-panel.active .tool-family-batches');
        if (!submenu || !panels || !navHost || !nav || !primary || !batch) return null;
        const submenuRect = submenu.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        const batchRect = batch.getBoundingClientRect();
        const primaryRect = primary.getBoundingClientRect();
        const remainingRect = remaining?.getBoundingClientRect();
        const batchStyle = getComputedStyle(batch.querySelector(':scope > span'));
        const primaryStyle = getComputedStyle(primary);
        const primaryPaddingRight = Number.parseFloat(primaryStyle.paddingRight) || 0;
        return {
            persistentHost: nav.parentElement === navHost,
            panelsInSubmenu: panels.parentElement === submenu,
            navInSubmenu: navHost.parentElement === submenu,
            centerDelta: Math.abs((navRect.top + navRect.height / 2) - (batchRect.top + batchRect.height / 2)),
            navRight: navRect.right,
            submenuRight: submenuRect.right,
            navOnlyUsesFirstRow: primaryPaddingRight >= navRect.width
              && (!remainingRect || remainingRect.width >= primaryRect.width - 1),
            toolNameNoWrap: batchStyle.whiteSpace === 'nowrap',
        };
    }""")
    expect(metrics is not None, f"{label}: missing stable family submenu metrics")
    expect(metrics["persistentHost"] and metrics["panelsInSubmenu"] and metrics["navInSubmenu"], f"{label}: family menu should keep one persistent pager host ({metrics})")
    expect(metrics["centerDelta"] <= 6, f"{label}: pager should align with the batch menu ({metrics})")
    expect(metrics["navRight"] <= metrics["submenuRight"] + 1, f"{label}: pager should stay inside the submenu grid ({metrics})")
    expect(metrics["navOnlyUsesFirstRow"], f"{label}: pager should not reserve a full-height submenu column ({metrics})")
    expect(metrics["toolNameNoWrap"], f"{label}: batch tool names should stay on one line ({metrics})")


def expect_read_article_batches_use_titles(page, label):
    metrics = page.evaluate("""() => {
        const batches = [...document.querySelectorAll('.tool-family-batch[data-tool-family-id="collect"]')]
          .filter(node => node.textContent.includes('采集正文'));
        return {
            count: batches.length,
            hasTitle: batches.some(node => node.textContent.includes('正文样本')),
            hasTabId: batches.some(node => /标签页\\s+\\d+/.test(node.textContent || '')),
            texts: batches.map(node => node.textContent.trim()).slice(0, 4),
        };
    }""")
    expect(metrics["count"] > 0, f"{label}: missing read_article batch ({metrics})")
    expect(metrics["hasTitle"], f"{label}: read_article batch should show page title ({metrics})")
    expect(not metrics["hasTabId"], f"{label}: read_article batch should not show tab id ({metrics})")


def expect_page_scoped_batches_avoid_tab_ids(page, label):
    metrics = page.evaluate("""() => {
        const labels = [
          '新开页面',
          '页面跳转',
          '等待加载',
          '采集正文',
          '读取 HTML',
          '解析页面树',
          '查找元素',
          '操作元素',
          '页面截图',
          '执行脚本',
          '注入样式',
          '修改 DOM',
          '查看 Console',
          '监听网络',
          '查看网络请求',
        ];
        const batches = [...document.querySelectorAll('.tool-family-batch')]
          .filter(node => labels.some(label => (node.textContent || '').includes(label)));
        const bad = batches
          .filter(node => /标签页\\s+\\d+/.test(node.textContent || ''))
          .map(node => node.textContent.trim());
        return { count: batches.length, bad };
    }""")
    expect(metrics["count"] > 0, f"{label}: missing page-scoped batches ({metrics})")
    expect(not metrics["bad"], f"{label}: page-scoped batches should use titles instead of tab ids ({metrics})")


def click_visible_copy_button(page, card, name):
    buttons = card.locator(".code-copy-btn")
    count = buttons.count()
    clicked = 0
    for index in range(count):
        button = buttons.nth(index)
        if not button.is_visible():
            continue
        button.click()
        page.wait_for_timeout(45)
        expect(button.get_attribute("title") == "已复制", f"{name}: copy button did not show copied state")
        flash = button.evaluate("(node) => node.closest('.copyable-code-block')?.classList.contains('copy-confirmed') || false")
        expect(flash, f"{name}: copy button did not flash containing code block")
        copied = page.evaluate("() => window.__lastCopiedText || ''")
        expect(bool(copied.strip()), f"{name}: copy button copied empty text")
        clicked += 1
        break
    return clicked


def collect_page_stats(page, scenario):
    return {
        "scenario": scenario,
        "timelineGroups": page.locator(".msg-tool-timeline").count(),
        "thinkingGroups": page.locator(".msg-thinking-group").count(),
        "familyRows": page.locator(".tool-family-row").count(),
        "tables": page.locator(".tool-data-table").count(),
        "codeBlocks": page.locator(".js-code-block, .json-block").count(),
        "waiting": page.locator(".tool-timeline-summary-waiting, .tool-timeline-step.waiting").count(),
        "errors": page.locator(".tool-timeline-step.error").count(),
    }


def run_operations_with_frames(page, operations, frame_dir, frame_target):
    frame_dir.mkdir(parents=True, exist_ok=True)
    frame_paths = []
    capture_frame(page, frame_dir / "frame_000.png", frame_target)
    frame_paths.append(frame_dir / "frame_000.png")
    for index, operation in enumerate(operations, start=1):
        page.evaluate("(op) => window.visualTimelineTest.runOperationFlow([op])", operation)
        page.wait_for_timeout(int(operation.get("recordDelay", operation.get("delay", 220))))
        frame = frame_dir / f"frame_{index:03d}.png"
        capture_frame(page, frame, frame_target)
        frame_paths.append(frame)
    return frame_paths


def capture_frame(page, path, target):
    if target == "device":
        page.evaluate("() => window.scrollTo(0, 0)")
        box = page.locator(".visual-device").bounding_box()
        viewport = page.viewport_size or {"width": 1180, "height": 980}
        if not box:
            page.screenshot(path=path, full_page=False)
            return
        x = max(0, int(round(box["x"])))
        y = max(0, int(round(box["y"])))
        width = max(1, min(int(round(box["width"])), viewport["width"] - x))
        height = max(1, min(int(round(box["height"])), viewport["height"] - y - 8))
        page.screenshot(path=path, clip={
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        })
    else:
        page.screenshot(path=path, full_page=False)


def make_gif(frame_dir, output_path, fps):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg，无法合成 GIF")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    palette = frame_dir / "palette.png"
    frame_pattern = str(frame_dir / "frame_%03d.png")
    subprocess.run([
        ffmpeg, "-y", "-framerate", str(fps), "-i", frame_pattern,
        "-vf", "palettegen=stats_mode=diff", str(palette),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        ffmpeg, "-y", "-framerate", str(fps), "-i", frame_pattern, "-i", str(palette),
        "-lavfi", "paletteuse=dither=bayer:bayer_scale=3", str(output_path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def sidepanel_url_for(visual_url):
    return visual_url.split("/tests/tool-timeline/", 1)[0] + "/extension/sidepanel/sidepanel.html"


def expect_sidepanel_settings_smoke(browser, visual_url):
    sidepanel_url = sidepanel_url_for(visual_url)
    page = browser.new_page(locale="zh-CN", viewport={"width": 420, "height": 860}, device_scale_factor=1)
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script("""
    (() => {
      const listeners = { message: [], disconnect: [], changed: [] };
      const port = {
        onMessage: { addListener(fn) { listeners.message.push(fn); } },
        onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
        postMessage(msg) {
          if (msg?.type === 'list_plugin_contributions' && msg.requestId) {
            setTimeout(() => {
              listeners.message.slice().forEach(fn => fn({ type: 'plugin_contributions', requestId: msg.requestId, plugins: [], diagnostics: [], version: 1 }));
              window.__pluginCatalogResponses = (window.__pluginCatalogResponses || 0) + 1;
            }, 0);
            return;
          }
          if (msg && msg.type === 'get_config') {
            setTimeout(() => listeners.message.forEach(fn => fn({
              type: 'config',
              config: { provider: '', model: '', apiKey: '', modelProvider: '' },
              presets: [],
            })), 0);
          }
          if (msg && msg.type === 'get_messages') {
            setTimeout(() => listeners.message.forEach(fn => fn({ type: 'messages', history: [] })), 0);
          }
        },
      };
      window.chrome = {
        runtime: {
          connect() { return port; },
          getURL(path) { return '/extension/' + path; },
          sendMessage() {},
        },
        storage: {
          local: {
            async get(key) { return key === 'qz_data_consent' ? { qz_data_consent: { version: 1, acceptedAt: 1 } } : {}; },
            async set() {},
            async remove() {},
          },
          onChanged: { addListener(fn) { listeners.changed.push(fn); } },
        },
        downloads: { async download() {}, async search() { return []; } },
        tabs: { async query() { return []; }, async create() { return {}; } },
        desktopCapture: { chooseDesktopMedia() {} },
      };
    })();
    """)
    try:
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.wait_for_selector("#btn-settings")
        before = page.locator("#settings-panel").evaluate("node => node.classList.contains('hidden')")
        page.click("#btn-settings")
        page.wait_for_timeout(200)
        after = page.locator("#settings-panel").evaluate("node => node.classList.contains('hidden')")
        expect(before is True and after is False, f"sidepanel settings: gear did not open settings panel before={before} after={after}")
        expect(page.locator(".guardrail-section .settings-advanced-hint").count() == 0, "sidepanel settings: redundant security policy hint leaked")
        page.wait_for_function("window.__pluginCatalogResponses > 0")
        expect(not page_errors, "sidepanel settings page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "sidepanel settings console errors: " + json.dumps(console_errors, ensure_ascii=False))
    finally:
        page.close()


def expect_sidepanel_session_delete_stability(browser, visual_url):
    sidepanel_url = sidepanel_url_for(visual_url)
    page = browser.new_page(locale="zh-CN", viewport={"width": 420, "height": 860}, device_scale_factor=1)
    page.emulate_media(color_scheme="light")
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script("""
    (() => {
      const listeners = { message: [], disconnect: [], changed: [] };
      const sessions = {
        'session-newest': { id: 'session-newest', title: '最新任务', parentSessionId: '0', createdAt: '2026-07-12 10:03:00', updatedAt: '2026-07-12 10:03:00' },
        'session-middle': { id: 'session-middle', title: '中间任务', parentSessionId: '0', createdAt: '2026-07-12 10:02:00', updatedAt: '2026-07-12 10:02:00' },
        'session-oldest': { id: 'session-oldest', title: '较早任务', parentSessionId: '0', createdAt: '2026-07-12 10:01:00', updatedAt: '2026-07-12 10:01:00' },
      };
      const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      const emit = event => listeners.message.slice().forEach(fn => fn(event));
      const storage = { qz_data_consent: { version: 1, acceptedAt: 1 }, _sessions: sessions };
      const storageGet = async keys => {
        if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
        if (keys && typeof keys === 'object') {
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(storage[key] ?? fallback)]));
        }
        return clone(storage);
      };
      const port = {
        onMessage: { addListener(fn) { listeners.message.push(fn); } },
        onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
        postMessage(msg) {
          if (msg?.type === 'list_plugin_contributions' && msg.requestId) {
            setTimeout(() => {
              listeners.message.slice().forEach(fn => fn({ type: 'plugin_contributions', requestId: msg.requestId, plugins: [], diagnostics: [], version: 1 }));
              window.__pluginCatalogResponses = (window.__pluginCatalogResponses || 0) + 1;
            }, 0);
            return;
          }
          if (!msg) return;
          if (msg.type === 'get_config') {
            setTimeout(() => emit({
              type: 'config',
              config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai' },
              presets: [],
            }), 0);
            return;
          }
          if (msg.type === 'list_sessions' && msg.requestId) {
            setTimeout(() => emit({ requestId: msg.requestId, sessions: Object.values(sessions) }), 0);
            return;
          }
          if (msg.type === 'delete_session' && msg.requestId) {
            const id = String(msg.sessionId || '');
            delete sessions[id];
            setTimeout(() => {
              emit({ type: 'session_deleted', sessionId: id, deleted: true, existed: true });
              emit({ type: 'sessions_changed', action: 'delete', sessionId: id });
              emit({ type: 'delete_session_result', requestId: msg.requestId, sessionId: id, deleted: true });
            }, 30);
          }
        },
      };
      window.chrome = {
        runtime: {
          connect() { return port; },
          getURL(path) { return '/extension/' + path; },
          sendMessage() {},
        },
        storage: {
          local: {
            get: storageGet,
            async set(values) { Object.assign(storage, clone(values || {})); },
            async remove(keys) {
              (Array.isArray(keys) ? keys : [keys]).filter(Boolean).forEach(key => delete storage[key]);
            },
          },
          onChanged: { addListener(fn) { listeners.changed.push(fn); } },
        },
        downloads: { async download() {}, async search() { return []; } },
        tabs: { async query() { return []; }, async create() { return {}; } },
        desktopCapture: { chooseDesktopMedia() {} },
      };
    })();
    """)
    try:
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.click('.tab-btn[data-tab="sessions"]')
        page.wait_for_function("document.querySelectorAll('#sessions-list .session-card[data-id]').length === 3")
        page.fill("#sessions-search", "较早")
        page.wait_for_function("""
        () => {
          const cards = [...document.querySelectorAll('#sessions-list .session-card[data-id]')];
          return cards.length === 1 && cards[0].dataset.id === 'session-oldest';
        }
        """)
        search_motion = page.evaluate("""() => ({
          ghosts: document.querySelectorAll('#sessions-list > .session-removal-ghost').length,
          moving: document.querySelectorAll('#sessions-list .session-card.is-layout-moving').length,
        })""")
        expect(search_motion == {"ghosts": 0, "moving": 0}, f"session search: query changes should reconcile without overlapping motion {search_motion}")
        page.fill("#sessions-search", "")
        page.wait_for_function("document.querySelectorAll('#sessions-list .session-card[data-id]').length === 3")
        search_clear_motion = page.evaluate("""() => ({
          ghosts: document.querySelectorAll('#sessions-list > .session-removal-ghost').length,
          moving: document.querySelectorAll('#sessions-list .session-card.is-layout-moving').length,
        })""")
        expect(search_clear_motion == {"ghosts": 0, "moving": 0}, f"session search: clearing a query should restore cards without overlap {search_clear_motion}")
        page.emulate_media(color_scheme="dark")
        page.wait_for_timeout(40)
        page.evaluate("""
        () => {
          const id = 'session-middle';
          const card = document.querySelector(`.session-card[data-id="${id}"]`);
          window.__sessionDeleteProbe = {
            id,
            originalTop: card.closest('.session-tree-node').getBoundingClientRect().top,
            originalLeft: card.closest('.session-tree-node').getBoundingClientRect().left,
            ghostTop: null,
            ghostLeft: null,
            ghostParent: '',
            ghostPosition: '',
            frames: [],
          };
          const observer = new MutationObserver(records => {
            for (const record of records) {
              for (const added of record.addedNodes) {
                if (!(added instanceof Element)) continue;
                const ghost = added.matches('.session-removal-ghost') ? added : added.querySelector('.session-removal-ghost');
                if (!ghost?.querySelector(`.session-card[data-id="${id}"]`)) continue;
                const firstRect = ghost.getBoundingClientRect();
                window.__sessionDeleteProbe.ghostTop = firstRect.top;
                window.__sessionDeleteProbe.ghostLeft = firstRect.left;
                window.__sessionDeleteProbe.ghostParent = ghost.parentElement?.id || '';
                window.__sessionDeleteProbe.ghostPosition = getComputedStyle(ghost).position;
                const sample = () => {
                  if (!ghost.isConnected) return;
                  const rect = ghost.getBoundingClientRect();
                  window.__sessionDeleteProbe.frames.push({ top: rect.top, left: rect.left });
                  requestAnimationFrame(sample);
                };
                sample();
                observer.disconnect();
                return;
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }
        """)
        page.click('.session-card[data-id="session-middle"] .session-delete-btn')
        page.wait_for_function("window.__sessionDeleteProbe?.ghostTop !== null")
        page.wait_for_timeout(80)
        probe = page.evaluate("window.__sessionDeleteProbe")
        top_delta = abs(round(probe["ghostTop"]) - round(probe["originalTop"]))
        left_delta = abs(round(probe["ghostLeft"]) - round(probe["originalLeft"]))
        frame_top_delta = max((abs(round(frame["top"]) - round(probe["ghostTop"])) for frame in probe["frames"]), default=0)
        frame_left_delta = max((abs(round(frame["left"]) - round(probe["ghostLeft"])) for frame in probe["frames"]), default=0)
        expect(top_delta <= 3 and left_delta <= 1, f"session delete: exit ghost moved before removal {probe}")
        expect(frame_top_delta <= 1 and frame_left_delta <= 1, f"session delete: exit ghost changed position during collapse {probe}")
        expect(probe["ghostParent"] == "sessions-list" and probe["ghostPosition"] == "absolute", f"session delete: ghost escaped local list layer {probe}")
        layer_probe = page.evaluate("""() => {
          const ghost = document.querySelector('#sessions-list > .session-removal-ghost');
          const moving = document.querySelector('.session-card[data-id="session-oldest"]');
          if (!ghost || !moving) return null;
          const ghostRect = ghost.getBoundingClientRect();
          const movingRect = moving.getBoundingClientRect();
          const overlapTop = Math.max(ghostRect.top, movingRect.top);
          const overlapBottom = Math.min(ghostRect.bottom, movingRect.bottom);
          const x = Math.max(ghostRect.left, movingRect.left) + Math.min(ghostRect.width, movingRect.width) / 2;
          const y = overlapTop + Math.max(0, overlapBottom - overlapTop) / 2;
          const hit = overlapBottom > overlapTop ? document.elementFromPoint(x, y) : null;
          const keyframes = ghost.getAnimations()[0]?.effect?.getKeyframes?.() || [];
          return {
            overlapHeight: overlapBottom - overlapTop,
            hitSessionId: hit?.closest?.('.session-card[data-id]')?.dataset?.id || '',
            ghostZ: getComputedStyle(ghost).zIndex,
            movingZ: getComputedStyle(moving).zIndex,
            ghostOpacity: Number(getComputedStyle(ghost).opacity),
            movingSurface: getComputedStyle(moving, '::before').backgroundColor,
            keyframes,
          };
        }""")
        expect(layer_probe is not None and layer_probe["overlapHeight"] >= 4, f"session delete: retained card did not overlap the rear exit layer {layer_probe}")
        expect(layer_probe["hitSessionId"] == "session-oldest", f"session delete: moving card should cover the removed card at overlap points {layer_probe}")
        expect(layer_probe["ghostZ"] == "0" and layer_probe["movingZ"] == "2", f"session delete: rear/foreground z-order is not explicit {layer_probe}")
        expect(layer_probe["ghostOpacity"] == 1, f"session delete: removed card should not opacity-blend while being covered {layer_probe}")
        expect(layer_probe["movingSurface"] not in ("", "transparent", "rgba(0, 0, 0, 0)"), f"session delete: moving dark-mode card needs an opaque covering surface {layer_probe}")
        expect(
            layer_probe["keyframes"]
            and all(frame.get("opacity") is None for frame in layer_probe["keyframes"])
            and any("100%" in str(frame.get("clipPath") or "") for frame in layer_probe["keyframes"]),
            f"session delete: exit layer should collapse without opacity animation {layer_probe}",
        )
        layout_animation_count = page.locator('.session-card[data-id="session-oldest"]').evaluate("node => node.getAnimations().length")
        expect(layout_animation_count >= 1, "session delete: retained cards lost their FLIP layout animation")
        page.wait_for_function("!document.querySelector('.session-card[data-id=\"session-middle\"]')")
        page.wait_for_function("document.querySelectorAll('#sessions-list .session-card[data-id]').length === 2")
        page.evaluate("""() => document.querySelector('.session-card[data-id="session-newest"] .session-delete-btn')?.click()""")
        page.wait_for_function("""
        () => [...document.querySelectorAll('#sessions-list > .session-removal-ghost')]
          .some(ghost => ghost.querySelector('.session-card[data-id="session-newest"]'))
        """)
        interrupted_motion = page.evaluate("""() => {
          const card = document.querySelector('.session-card[data-id="session-oldest"]');
          return card ? {
            moving: card.classList.contains('is-layout-moving'),
            zIndex: getComputedStyle(card).zIndex,
            surface: getComputedStyle(card, '::before').backgroundColor,
          } : null;
        }""")
        expect(
            interrupted_motion
            and interrupted_motion["moving"]
            and interrupted_motion["zIndex"] == "2"
            and interrupted_motion["surface"] not in ("", "transparent", "rgba(0, 0, 0, 0)"),
            f"session delete: an interrupted FLIP must retain the new foreground animation state {interrupted_motion}",
        )
        page.wait_for_function("document.querySelectorAll('#sessions-list .session-card[data-id]').length === 1")
        page.wait_for_function("document.querySelectorAll('#sessions-list > .session-removal-ghost').length === 0")
        remaining_id = page.locator("#sessions-list .session-card[data-id]").get_attribute("data-id")
        expect(remaining_id == "session-oldest", f"session delete: consecutive deletion left the wrong card {remaining_id}")
        page.wait_for_function("window.__pluginCatalogResponses > 0")
        expect(not page_errors, "session delete page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "session delete console errors: " + json.dumps(console_errors, ensure_ascii=False))
    finally:
        page.close()


def expect_tool_pager_viewport_stability(page):
    setup_script = r"""async (mode) => {
      const { createToolTimelineGroupElement } = await import('/extension/sidepanel/tools/tool-timeline-renderer.js');
      const messages = document.querySelector('#messages');
      const makeTool = (name, key, args, result) => ({
        type: 'tool',
        _uiKey: key,
        toolCallId: key,
        runId: `pager-${mode}`,
        name,
        args,
        result,
        timestamp: '2026-07-11 12:00:00',
      });
      const longText = Array.from({ length: 80 }, (_, index) => `正文第 ${index + 1} 行，用来制造明显不同的工具详情高度。`).join('\n');
      let entries;
      let activeToolKey;
      if (mode === 'family') {
        entries = [
          ...Array.from({ length: 6 }, (_, index) => makeTool(
            'open_tab',
            `pager-family-open-${index}`,
            { url: `https://example.com/page-${index}` },
            { title: `页面 ${index}`, url: `https://example.com/page-${index}` },
          )),
          ...Array.from({ length: 6 }, (_, index) => makeTool(
            'read_article',
            `pager-family-read-${index}`,
            { source: 'auto' },
            { title: `长正文 ${index}`, text: longText },
          )),
          makeTool('data_store', 'pager-family-data', { table: 'pager_rows' }, {
            table: 'pager_rows',
            totalRows: 1,
            rows: [{ id: 1, title: '短详情' }],
          }),
        ];
        activeToolKey = 'pager-family-read-5';
      } else {
        entries = [
          makeTool('read_article', 'pager-regular-long', { source: 'auto' }, { title: '长正文', text: longText }),
          makeTool('open_tab', 'pager-regular-short', { url: 'https://example.com/short' }, { title: '短详情', url: 'https://example.com/short' }),
          makeTool('data_store', 'pager-regular-data', { table: 'pager_rows' }, {
            table: 'pager_rows',
            totalRows: 1,
            rows: [{ id: 1, title: '表格详情' }],
          }),
        ];
        activeToolKey = 'pager-regular-long';
      }

      const spacer = document.createElement('div');
      spacer.dataset.pagerTestSpacer = mode;
      spacer.style.height = '420px';
      spacer.style.flex = '0 0 auto';
      const card = createToolTimelineGroupElement({
        type: 'tool-group',
        _uiKey: `pager-${mode}-group`,
        runId: `pager-${mode}`,
        entries,
      }, { expanded: true, activeToolKey });
      const tail = document.createElement('div');
      tail.style.height = '900px';
      tail.style.flex = '0 0 auto';
      messages.replaceChildren(spacer, card, tail);

      const pager = card.querySelector('.tool-timeline-slot-nav');
      messages.scrollTop += pager.getBoundingClientRect().top - 250;
      messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, bubbles: true }));
      card.addEventListener('click', (event) => {
        if (!event.target.closest?.('.tool-timeline-nav-btn')) return;
        spacer.style.height = spacer.style.height === '420px' ? '492px' : '420px';
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        mode: card.querySelector('.tool-timeline-details')?.dataset.timelineMode || '',
        pagerCount: card.querySelectorAll('.tool-timeline-slot-nav').length,
        scrollable: messages.scrollHeight > messages.clientHeight,
        top: card.querySelector('.tool-timeline-slot-nav')?.getBoundingClientRect().top || 0,
      };
    }"""

    for mode, directions in (("regular", (1, -1, 1, -1)), ("family", (1, -1, 1, -1))):
        setup = page.evaluate(setup_script, mode)
        expected_mode = "steps" if mode == "regular" else "family"
        expect(setup["mode"] == expected_mode and setup["pagerCount"] == 1 and setup["scrollable"], f"pager {mode}: invalid fixture {setup}")
        for direction in directions:
            selector = f'.tool-timeline-nav-btn[data-timeline-nav-direction="{direction}"]'
            button = page.locator(selector).first
            expect(button.is_enabled(), f"pager {mode}: direction {direction} should be enabled")
            button.scroll_into_view_if_needed()
            page.wait_for_timeout(20)
            before = page.evaluate("""() => {
                const messages = document.querySelector('#messages');
                const pager = document.querySelector('.tool-timeline-slot-nav');
                const body = document.querySelector('.tool-timeline-slot-body');
                return {
                    top: pager?.getBoundingClientRect().top || 0,
                    scrollTop: messages?.scrollTop || 0,
                    scrollHeight: messages?.scrollHeight || 0,
                    clientHeight: messages?.clientHeight || 0,
                    bodyHeight: body?.getBoundingClientRect().height || 0,
                };
            }""")
            button.click()
            page.wait_for_timeout(80)
            after = page.evaluate("""() => {
                const messages = document.querySelector('#messages');
                const pager = document.querySelector('.tool-timeline-slot-nav');
                const body = document.querySelector('.tool-timeline-slot-body');
                return {
                    top: pager?.getBoundingClientRect().top || 0,
                    scrollTop: messages?.scrollTop || 0,
                    scrollHeight: messages?.scrollHeight || 0,
                    clientHeight: messages?.clientHeight || 0,
                    bodyHeight: body?.getBoundingClientRect().height || 0,
                };
            }""")
            expect(abs(after["top"] - before["top"]) <= 1, f"pager {mode}: viewport top moved after detail switch ({before} -> {after})")


def expect_sidepanel_assistant_actions_smoke(browser, visual_url):
    sidepanel_url = sidepanel_url_for(visual_url)
    page = browser.new_page(locale="zh-CN", viewport={"width": 420, "height": 860}, device_scale_factor=1)
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script("""
    (() => {
      const listeners = { message: [], disconnect: [], changed: [] };
      const session = { id: 'sess-actions', title: '按钮可见性测试', parentSessionId: 'root' };
      const port = {
        onMessage: { addListener(fn) { listeners.message.push(fn); } },
        onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
        postMessage(msg) {
          if (msg?.type === 'list_plugin_contributions' && msg.requestId) {
            setTimeout(() => {
              listeners.message.slice().forEach(fn => fn({ type: 'plugin_contributions', requestId: msg.requestId, plugins: [], diagnostics: [], version: 1 }));
              window.__pluginCatalogResponses = (window.__pluginCatalogResponses || 0) + 1;
            }, 0);
            return;
          }
          if (!msg) return;
          if (msg.type === 'get_config') {
            setTimeout(() => window.__emitPortMessage({
              type: 'config',
              config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai' },
              presets: [],
            }), 0);
            return;
          }
          if (msg.type === 'create_ui_session' && msg.requestId) {
            setTimeout(() => window.__emitPortMessage({ requestId: msg.requestId, session }), 0);
            return;
          }
          if (msg.type === 'list_sessions' && msg.requestId) {
            setTimeout(() => window.__emitPortMessage({ requestId: msg.requestId, sessions: [] }), 0);
            return;
          }
          if (msg.type === 'export_session_exchange' && msg.requestId) {
            window.__pendingSessionExport = msg;
            return;
          }
          if (msg.type === 'prompt') {
            window.__lastPromptMessage = msg;
          }
        },
      };
      window.__emitPortMessage = (event) => {
        listeners.message.slice().forEach(fn => fn(event));
      };
      window.chrome = {
        runtime: {
          connect() { return port; },
          getURL(path) { return '/extension/' + path; },
          sendMessage() {},
        },
        storage: {
          local: {
            async get(key) {
              if (key === 'qz_data_consent') return { qz_data_consent: { version: 1, acceptedAt: 1 } };
              if (key === '_sessions') return { _sessions: { [session.id]: session } };
              return {};
            },
            async set() {},
            async remove() {},
          },
          onChanged: { addListener(fn) { listeners.changed.push(fn); } },
        },
        downloads: {
          async download(options) {
            window.__downloadCalls = (window.__downloadCalls || 0) + 1;
            window.__lastDownloadOptions = options;
            return window.__downloadCalls;
          },
          async search() { return []; },
        },
        tabs: { async query() { return []; }, async create() { return {}; } },
        desktopCapture: { chooseDesktopMedia() {} },
      };
    })();
    """)
    try:
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.wait_for_selector("#input")
        page.fill("#input", "第一轮")
        page.click("#btn-send")
        page.wait_for_function("window.__lastPromptMessage && document.querySelectorAll('.msg-user').length === 1")

        page.evaluate("""
        () => {
          window.__emitPortMessage({ type: 'agent_start', sessionId: 'sess-actions', runId: 'run-1' });
          window.__emitPortMessage({ type: 'message_update', sessionId: 'sess-actions', runId: 'run-1', spanId: 'a1', content: '第一轮回答正在生成' });
        }
        """)
        page.wait_for_function("document.querySelectorAll('.msg-assistant').length === 1")
        expect(page.locator(".msg-actions").count() == 0, "assistant actions: streaming reply should not show actions")

        page.evaluate("""
        () => window.__emitPortMessage({
          type: 'message_end',
          sessionId: 'sess-actions',
          runId: 'run-1',
          spanId: 'a1',
          message: { role: 'assistant', content: '第一轮回答完成。' },
        })
        """)
        page.wait_for_timeout(160)
        expect(page.locator(".msg-actions").count() == 0, "assistant actions: completed text should stay hidden until run is idle")

        page.evaluate("() => window.__emitPortMessage({ type: 'agent_end', sessionId: 'sess-actions', runId: 'run-1' })")
        page.wait_for_function("document.querySelectorAll('.msg-actions .msg-action-btn').length === 2")

        page.wait_for_selector("#btn-export-session", state="visible")
        page.click("#btn-export-session")
        page.wait_for_timeout(120)
        export_pending = page.evaluate("""
        () => {
          const button = document.querySelector('#btn-export-session');
          const spinner = getComputedStyle(button, '::after');
          return {
            requestPending: Boolean(window.__pendingSessionExport),
            preparing: button.classList.contains('is-preparing'),
            disabled: button.disabled,
            ariaBusy: button.getAttribute('aria-busy'),
            downloadCalls: window.__downloadCalls || 0,
            animationName: spinner.animationName,
            spinnerOpacity: Number(spinner.opacity),
            title: button.title,
          };
        }
        """)
        expect(export_pending["requestPending"] and export_pending["preparing"] and export_pending["disabled"] and export_pending["ariaBusy"] == "true", f"session export: preparing state did not settle {export_pending}")
        expect(export_pending["downloadCalls"] == 0, f"session export: save dialog opened before document was ready {export_pending}")
        expect(export_pending["animationName"] == "session-export-spin" and export_pending["spinnerOpacity"] > 0, f"session export: preparing spinner is not visible {export_pending}")
        expect(export_pending["title"] == "正在准备导出", f"session export: preparing label is unclear {export_pending}")
        page.evaluate("""
        () => {
          const request = window.__pendingSessionExport;
          window.__emitPortMessage({
            requestId: request.requestId,
            payload: {
              format: 'qingzhou.session',
              version: 1,
              exportedAt: '2026-07-10 10:00:03',
              app: { name: '轻舟', version: 'test' },
              source: { sessionId: 'sess-actions', parentSessionId: 'root' },
              session: {
                title: '按钮可见性测试',
                createdAt: '2026-07-10 10:00:00',
                updatedAt: '2026-07-10 10:00:03',
                conversation: {
                  type: 'conversation',
                  version: 1,
                  entries: [
                    { type: 'message', id: 'entry_1', parentId: null, timestamp: '2026-07-10 10:00:00', message: { role: 'user', content: '第一轮' } },
                    { type: 'message', id: 'entry_2', parentId: 'entry_1', timestamp: '2026-07-10 10:00:03', message: { role: 'assistant', content: '第一轮回答完成。' } },
                  ],
                },
                transcript: [
                  { type: 'user', text: '第一轮', timestamp: '2026-07-10 10:00:00' },
                  { type: 'assistant', content: '第一轮回答完成。', timestamp: '2026-07-10 10:00:03' },
                ],
              },
              runtime: { status: 'completed', goal: null },
              dependencies: { skills: [], tools: [] },
            },
          });
        }
        """)
        page.wait_for_function("""
        () => {
          const button = document.querySelector('#btn-export-session');
          return window.__downloadCalls === 1 && !button?.classList.contains('is-preparing') && button?.getAttribute('aria-busy') == null;
        }
        """)
        download_options = page.evaluate("() => window.__lastDownloadOptions")
        expect(download_options.get("saveAs") is True and download_options.get("filename", "").endswith(".html"), f"session export: prepared document did not open the save dialog {download_options}")

        page.fill("#input", "第二轮")
        page.click("#btn-send")
        page.wait_for_function("document.querySelectorAll('.msg-user').length === 2 && document.querySelectorAll('.msg-actions').length === 0")
        expect(page.locator(".msg-actions").count() == 0, "assistant actions: previous turn actions should hide as soon as the next user turn starts")

        page.evaluate("""
        () => {
          window.__emitPortMessage({ type: 'agent_start', sessionId: 'sess-actions', runId: 'run-2' });
          window.__emitPortMessage({ type: 'message_update', sessionId: 'sess-actions', runId: 'run-2', spanId: 'a2', content: '第二轮回答' });
          window.__emitPortMessage({
            type: 'message_end',
            sessionId: 'sess-actions',
            runId: 'run-2',
            spanId: 'a2',
            message: { role: 'assistant', content: '第二轮回答完成。' },
          });
          window.__emitPortMessage({ type: 'agent_end', sessionId: 'sess-actions', runId: 'run-2' });
        }
        """)
        page.wait_for_function("document.querySelectorAll('.msg-actions .msg-action-btn').length === 2")
        assistant_texts = page.locator(".msg-assistant").all_text_contents()
        expect("第二轮回答完成" in assistant_texts[-1], f"assistant actions: latest assistant should remain visible {assistant_texts}")
        block_metrics = page.evaluate("""
        () => {
          const host = document.createElement('div');
          host.className = 'msg msg-assistant';
          host.innerHTML = `
            <div class="msg-content">
              <pre>const quiet = true;</pre>
              <blockquote>引用内容</blockquote>
              <div class="math-formula math-display standalone-math">L(θ) = E[x]</div>
              <div class="copyable-code-block math-code-block">
                <div class="math-formula math-display code-math">L(θ) = E[x]</div>
                <button class="code-copy-btn" type="button"></button>
              </div>
            </div>
          `;
          document.querySelector('#messages').appendChild(host);
          return [...host.querySelectorAll('pre, blockquote, .math-display')].map(node => {
            const style = getComputedStyle(node);
            return {
              tag: node.tagName.toLowerCase(),
              className: node.className,
              borderLeftWidth: parseFloat(style.borderLeftWidth || '0'),
              borderTopWidth: parseFloat(style.borderTopWidth || '0'),
              backgroundColor: style.backgroundColor,
            };
          });
        }
        """)
        expect(all(item["borderLeftWidth"] == 0 and item["borderTopWidth"] == 0 for item in block_metrics), f"assistant blocks should use Quiet Fill without borders {block_metrics}")
        expect(all(not item["backgroundColor"].endswith(", 0)") and item["backgroundColor"] != "transparent" for item in block_metrics), f"assistant blocks should keep a visible Quiet Fill background {block_metrics}")
        math_metrics = page.evaluate("""
        () => {
          const standalone = document.querySelector('.standalone-math');
          const codeBody = document.querySelector('.code-math');
          const codeWrap = document.querySelector('.math-code-block');
          const metric = (node) => {
            const style = getComputedStyle(node);
            return {
              marginTop: parseFloat(style.marginTop || '0'),
              marginBottom: parseFloat(style.marginBottom || '0'),
              paddingTop: parseFloat(style.paddingTop || '0'),
              paddingRight: parseFloat(style.paddingRight || '0'),
              paddingBottom: parseFloat(style.paddingBottom || '0'),
              paddingLeft: parseFloat(style.paddingLeft || '0'),
              minHeight: parseFloat(style.minHeight || '0'),
              radius: style.borderTopLeftRadius,
              backgroundColor: style.backgroundColor,
            };
          };
          return {
            standalone: metric(standalone),
            codeBody: metric(codeBody),
            codeWrap: metric(codeWrap),
          };
        }
        """)
        standalone = math_metrics["standalone"]
        code_body = math_metrics["codeBody"]
        code_wrap = math_metrics["codeWrap"]
        for key in ("paddingTop", "paddingBottom", "paddingLeft"):
            expect(abs(standalone[key] - code_body[key]) <= 0.5, f"math code block should match display math {key}: {math_metrics}")
        expect(abs(standalone["marginTop"] - code_wrap["marginTop"]) <= 0.5 and abs(standalone["marginBottom"] - code_wrap["marginBottom"]) <= 0.5, f"math code block wrapper margin should match display math {math_metrics}")
        expect(code_body["paddingRight"] >= standalone["paddingRight"], f"math code block keeps right copy-button room {math_metrics}")
        expect(code_body["minHeight"] <= 1, f"math code block should not add extra min-height padding {math_metrics}")
        expect(standalone["radius"] == code_body["radius"] and standalone["backgroundColor"] == code_body["backgroundColor"], f"math block surface should match {math_metrics}")
        expect_tool_pager_viewport_stability(page)
        page.wait_for_function("window.__pluginCatalogResponses > 0")
        expect(not page_errors, "assistant actions page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "assistant actions console errors: " + json.dumps(console_errors, ensure_ascii=False))
    finally:
        page.close()


def expect_sidepanel_artifacts_smoke(browser, visual_url):
    sidepanel_url = sidepanel_url_for(visual_url)
    page = browser.new_page(locale="zh-CN", viewport={"width": 420, "height": 860}, device_scale_factor=1)
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script("""
    (() => {
      const listeners = { message: [], disconnect: [], changed: [] };
      const session = { id: 'sess-artifacts', title: '产物测试任务', parentSessionId: 'root' };
      const storage = { qz_data_consent: { version: 1, acceptedAt: 1 }, _sessions: {} };
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const emit = (event) => listeners.message.slice().forEach(fn => fn(event));
      const storageGet = async (keys) => {
        if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
        if (keys && typeof keys === 'object') {
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(storage[key] ?? fallback)]));
        }
        return clone(storage);
      };
      const port = {
        onMessage: { addListener(fn) { listeners.message.push(fn); } },
        onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
        postMessage(msg) {
          if (msg?.type === 'list_plugin_contributions' && msg.requestId) {
            setTimeout(() => {
              listeners.message.slice().forEach(fn => fn({ type: 'plugin_contributions', requestId: msg.requestId, plugins: [], diagnostics: [], version: 1 }));
              window.__pluginCatalogResponses = (window.__pluginCatalogResponses || 0) + 1;
            }, 0);
            return;
          }
          if (!msg) return;
          if (msg.type === 'get_config') {
            setTimeout(() => emit({
              type: 'config',
              config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai' },
              presets: [],
            }), 0);
            return;
          }
          if (msg.type === 'create_ui_session' && msg.requestId) {
            storage._sessions[session.id] = session;
            setTimeout(() => emit({ requestId: msg.requestId, session }), 0);
            return;
          }
          if (msg.type === 'list_sessions' && msg.requestId) {
            setTimeout(() => emit({ requestId: msg.requestId, sessions: Object.values(storage._sessions) }), 0);
            return;
          }
          if (msg.type === 'prompt') {
            window.__lastPromptMessage = msg;
          }
        },
      };
      window.__emitPortMessage = emit;
      window.chrome = {
        runtime: {
          connect() { return port; },
          getURL(path) { return '/extension/' + path; },
          sendMessage() {},
        },
        storage: {
          local: {
            get: storageGet,
            async set(values) { Object.assign(storage, clone(values || {})); },
            async remove(keys) {
              (Array.isArray(keys) ? keys : [keys]).filter(Boolean).forEach(key => delete storage[key]);
            },
          },
          onChanged: { addListener(fn) { listeners.changed.push(fn); } },
        },
        permissions: { async request({ permissions }) { return permissions.every(value => value === 'downloads.open'); } },
        downloads: {
          async download(opts) { window.__downloadedArtifactOpts = opts || {}; },
          async search() { return []; },
          open(id) { window.__openedDownloadId = id; },
          show(id) { window.__shownDownloadId = id; },
        },
        tabs: { async query() { return []; }, async create() { return {}; } },
        desktopCapture: { chooseDesktopMedia() {} },
      };
    })();
    """)
    try:
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.wait_for_selector("#input")
        page.fill("#input", "生成一份产物")
        page.click("#btn-send")
        page.wait_for_function("window.__lastPromptMessage && document.querySelectorAll('.msg-user').length === 1")

        expect(page.locator(".msg-artifacts").count() == 0, "artifacts: empty session should not render an artifact card")
        has_title_artifacts_btn = page.locator("#current-session-artifacts-btn").count() > 0
        if has_title_artifacts_btn:
            expect("hidden" in (page.locator("#current-session-artifacts-btn").get_attribute("class") or ""), "artifacts: empty session should keep title entry hidden")

        page.click('.tab-btn[data-tab="sessions"]')
        page.wait_for_selector("#sessions-list .session-card")
        expect(page.locator("#sessions-list .session-artifact-action-btn").first.get_attribute("data-session-action") == "artifacts", "artifacts: empty session document action should open artifacts")
        page.click("#sessions-list .session-artifact-action-btn")
        page.wait_for_function("!document.querySelector('#artifacts-panel').classList.contains('hidden')")
        page.wait_for_function("document.querySelector('#artifacts-body')?.innerText.includes('0 个产物')")
        empty_panel_text = page.locator("#artifacts-panel").inner_text()
        expect("0 个产物" in empty_panel_text and "暂无产物" in empty_panel_text and "简报" not in empty_panel_text, f"artifacts: empty panel mismatch {empty_panel_text}")
        page.click("#btn-close-artifacts")
        page.wait_for_function("document.querySelector('#artifacts-panel').classList.contains('hidden')")
        page.click('.tab-btn[data-tab="chat"]')
        page.wait_for_selector("#messages")

        page.evaluate("""
        () => {
          const common = { sessionId: 'sess-artifacts', runId: 'run-artifacts' };
          window.__emitPortMessage({ type: 'agent_start', ...common });
          window.__emitPortMessage({
            type: 'tool_execution_start',
            ...common,
            spanId: 'tool-1',
            toolCallId: 'data-1',
            toolName: 'data_store',
            args: { action: 'insert', table: 'launch_leads', rows: [{ name: 'A' }, { name: 'B' }] },
          });
          window.__emitPortMessage({
            type: 'tool_execution_end',
            ...common,
            spanId: 'tool-1',
            toolCallId: 'data-1',
            toolName: 'data_store',
            args: { action: 'insert', table: 'launch_leads', rows: [{ name: 'A' }, { name: 'B' }] },
            result: { action: 'insert', table: 'launch_leads', inserted: 2, totalRows: 2, columns: ['name'] },
            timestamp: '2026-06-24 10:01:00',
          });
          window.__emitPortMessage({
            type: 'tool_execution_start',
            ...common,
            spanId: 'tool-2',
            toolCallId: 'file-1',
            toolName: 'save_file',
            args: { filename: 'launch-brief.csv' },
          });
          window.__emitPortMessage({
            type: 'tool_execution_end',
            ...common,
            spanId: 'tool-2',
            toolCallId: 'file-1',
            toolName: 'save_file',
            args: { filename: 'launch-brief.csv' },
            result: { filename: 'launch-brief.csv', size: 2048, downloadId: 17 },
            timestamp: '2026-06-24 10:02:00',
          });
          window.__emitPortMessage({
            type: 'tool_execution_start',
            ...common,
            spanId: 'tool-3',
            toolCallId: 'script-1',
            toolName: 'run_script',
            args: { code: 'await tools.data_store(...); await tools.save_file(...);' },
          });
          window.__emitPortMessage({
            type: 'tool_execution_end',
            ...common,
            spanId: 'tool-3',
            toolCallId: 'script-1',
            toolName: 'run_script',
            args: { code: 'await tools.data_store(...); await tools.save_file(...);' },
            result: {
              ok: true,
              hasResult: true,
              result: {
                ok: true,
                count: 3,
                artifacts: [
                  { type: 'data', id: 'data:script_metrics', table: 'script_metrics', totalRows: 3, action: 'upsert' },
                ],
              },
              artifacts: [
                { type: 'data', id: 'data:launch_leads', table: 'launch_leads', totalRows: 2, action: 'insert' },
                { type: 'data', table: 'script_metrics', totalRows: 3, action: 'upsert' },
                { type: 'file', filename: 'script-output.md', size: 512, downloadId: 19 },
              ],
            },
            timestamp: '2026-06-24 10:03:00',
          });
          window.__emitPortMessage({ type: 'agent_end', ...common });
        }
        """)
        page.wait_for_function("document.querySelectorAll('.msg-artifacts').length === 1")
        if has_title_artifacts_btn:
            expect(page.locator("#current-session-artifacts-btn").is_visible(), "artifacts: title entry should appear after real artifacts")
        else:
            expect(page.locator(".msg-artifacts .artifact-strip-open").is_visible(), "artifacts: compact open button should appear after real artifacts")
        artifact_text = page.locator(".msg-artifacts").inner_text()
        expect("产物" in artifact_text and "4" in artifact_text and "launch_leads" in artifact_text and "launch-brief.csv" in artifact_text and "script_metrics" in artifact_text and "script-output.md" in artifact_text, f"artifacts: compact row content mismatch {artifact_text}")
        expect("06-24 10:03" in artifact_text, f"artifacts: compact row should expose product timestamps {artifact_text}")
        compact_titles = page.evaluate("""
        () => [...document.querySelectorAll('.msg-artifacts .artifact-strip-item .artifact-strip-name > span')]
          .map(node => node.textContent.trim())
        """)
        expect(compact_titles[:3] == ["launch_leads", "script_metrics", "script-output.md"], f"artifacts: compact rows should sort by time desc with stable title ties {compact_titles}")
        expect("下载 17" not in artifact_text, f"artifacts: compact row should not expose internal download id {artifact_text}")
        expect("简报" not in artifact_text, f"artifacts: compact row should not expose reports {artifact_text}")
        expect(page.locator(".msg-artifacts .artifact-strip-item[data-artifact-action='open-file']").count() == 1, "artifacts: compact downloaded file row should be clickable")
        page.click(".msg-artifacts .artifact-strip-item[data-artifact-action='open-file']")
        page.wait_for_function("window.__openedDownloadId === 19")

        page.evaluate("() => { window.__openedDownloadId = 0; }")
        artifact_text = page.locator(".msg-artifacts").inner_text()
        expect("4" in artifact_text and "简报" not in artifact_text, f"artifacts: compact card should stay product-only {artifact_text}")

        if has_title_artifacts_btn:
            page.click("#current-session-artifacts-btn")
        else:
            page.click(".msg-artifacts .artifact-strip-open")
        page.wait_for_function("!document.querySelector('#artifacts-panel').classList.contains('hidden')")
        page.wait_for_function("document.querySelector('#artifacts-body')?.innerText.includes('4 个产物')")
        panel_text = page.locator("#artifacts-panel").inner_text()
        expect("4 个产物" in panel_text and "简报" not in panel_text and "数据表" in panel_text and "文件" in panel_text and "script_metrics" in panel_text and "script-output.md" in panel_text, f"artifacts: panel summary mismatch {panel_text}")
        expect("2026-06-24 10:03" in panel_text and "2026-06-24 10:02" in panel_text, f"artifacts: panel should expose full product timestamps {panel_text}")
        panel_titles = page.evaluate("""
        () => [...document.querySelectorAll('#artifacts-panel .artifacts-row .artifacts-row-title')]
          .map(node => node.textContent.trim())
        """)
        expect(panel_titles[:4] == ["launch_leads", "script_metrics", "script-output.md", "launch-brief.csv"], f"artifacts: panel rows should sort by time desc with stable title ties {panel_titles}")
        data_titles = page.evaluate("""
        () => [...document.querySelectorAll('#artifacts-panel .artifacts-row')]
          .filter(row => row.querySelector('.artifacts-row-kind')?.textContent.trim() === '数据表')
          .map(row => row.querySelector('.artifacts-row-title')?.textContent.trim())
        """)
        expect(data_titles.count("launch_leads") == 1 and data_titles.count("script_metrics") == 1, f"artifacts: data artifacts should dedupe by table name {data_titles}")
        expect("暂无产物" not in panel_text, f"artifacts: populated panel should not show empty state {panel_text}")
        expect("下载 17" not in panel_text, f"artifacts: panel should not expose internal download id {panel_text}")
        expect(page.locator("#artifacts-panel .artifacts-section-title").count() == 0, "artifacts: panel should render a flat artifact list without section titles")
        expect(page.locator("#artifacts-panel .artifacts-row[data-artifact-action='open-file']").count() == 2, "artifacts: downloaded file rows should be clickable")
        page.click("#artifacts-panel .artifacts-row[data-artifact-action='open-file']")
        page.wait_for_function("window.__openedDownloadId === 19")
        page.click("#btn-close-artifacts")
        page.wait_for_function("document.querySelector('#artifacts-panel').classList.contains('hidden')")

        page.fill("#input", "继续做第二轮")
        page.click("#btn-send")
        page.wait_for_function("document.querySelectorAll('.msg-user').length === 2")
        page.wait_for_function("!document.querySelector('.msg-artifacts:not(.msg-artifacts-exiting)')")
        page.wait_for_function("document.querySelectorAll('.msg-artifacts').length === 0")

        page.evaluate("""
        () => {
          const common = { sessionId: 'sess-artifacts', runId: 'run-artifacts-2' };
          window.__emitPortMessage({ type: 'agent_start', ...common });
          window.__emitPortMessage({
            type: 'tool_execution_start',
            ...common,
            spanId: 'tool-3',
            toolCallId: 'file-2',
            toolName: 'save_file',
            args: { filename: 'round-2.csv' },
          });
          window.__emitPortMessage({
            type: 'tool_execution_end',
            ...common,
            spanId: 'tool-3',
            toolCallId: 'file-2',
            toolName: 'save_file',
            args: { filename: 'round-2.csv' },
            result: { filename: 'round-2.csv', size: 1024, downloadId: 18 },
            timestamp: '2026-06-24 10:04:00',
          });
        }
        """)
        page.wait_for_timeout(180)
        expect(page.locator(".msg-artifacts:not(.msg-artifacts-exiting)").count() == 0, "artifacts: in-progress round should not show a product card")

        page.evaluate("() => window.__emitPortMessage({ type: 'agent_end', sessionId: 'sess-artifacts', runId: 'run-artifacts-2' })")
        page.wait_for_function("document.querySelectorAll('.msg-artifacts:not(.msg-artifacts-exiting)').length === 1")
        latest_artifact_text = page.locator(".msg-artifacts:not(.msg-artifacts-exiting)").inner_text()
        expect("5" in latest_artifact_text and "launch_leads" in latest_artifact_text, f"artifacts: returned card should summarize cumulative artifacts {latest_artifact_text}")
        latest_titles = page.evaluate("""
        () => [...document.querySelectorAll('.msg-artifacts:not(.msg-artifacts-exiting) .artifact-strip-item .artifact-strip-name > span')]
          .map(node => node.textContent.trim())
        """)
        expect(latest_titles[0] == "round-2.csv", f"artifacts: newest second-round artifact should appear first {latest_titles}")

        page.click('.tab-btn[data-tab="sessions"]')
        page.wait_for_selector("#sessions-list .session-card")
        page.wait_for_function("document.querySelector('#sessions-list .session-artifact-chip')?.innerText.includes('5')")
        session_card_text = page.locator("#sessions-list .session-card").first.inner_text()
        expect("产物" in session_card_text and "5" in session_card_text, f"artifacts: session list should expose compact artifact count {session_card_text}")
        expect(page.locator("#sessions-list .session-artifact-line").count() == 0, "artifacts: session list should not render a secondary artifact chip")
        expect(page.locator("#sessions-list .session-artifact-action-btn").first.get_attribute("data-session-action") == "artifacts", "artifacts: session document action should always open artifacts")
        page.click("#sessions-list .session-artifact-chip")
        page.wait_for_function("!document.querySelector('#artifacts-panel').classList.contains('hidden')")
        page.wait_for_function("document.querySelector('#artifacts-body')?.innerText.includes('5 个产物')")
        list_panel_text = page.locator("#artifacts-panel").inner_text()
        expect("5 个产物" in list_panel_text and "round-2.csv" in list_panel_text, f"artifacts: session list entry should open artifact panel {list_panel_text}")
        page.wait_for_function("window.__pluginCatalogResponses > 0")
        expect(not page_errors, "artifacts page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "artifacts console errors: " + json.dumps(console_errors, ensure_ascii=False))
    finally:
        page.close()


def expect_sidepanel_automation_artifacts_smoke(browser, visual_url):
    sidepanel_url = sidepanel_url_for(visual_url)
    page = browser.new_page(locale="zh-CN", viewport={"width": 420, "height": 860}, device_scale_factor=1)
    page_errors = []
    console_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script("""
    (() => {
      const listeners = { message: [], disconnect: [], changed: [] };
      const automation = {
        id: 'auto-price',
        title: '每日竞品价格巡检',
        instruction: '每天抓取竞品页面，整理价格、新品和库存异常。',
        schedule: { type: 'daily', time: '09:00', weekday: 1, intervalHours: 24, intervalMinutes: 60 },
        missedPolicy: 'run_once',
        notifyPolicy: 'failure',
        enabled: true,
        status: 'idle',
        nextRunAt: '2026-06-16 09:00:00',
        lastRunId: 'run-price-1',
        lastRunStatus: 'completed',
        lastRunAt: '2026-06-15 09:04:31',
        createdAt: '2026-06-15 08:00:00',
        updatedAt: '2026-06-15 09:04:31',
      };
      const run = {
        id: 'run-price-1',
        automationId: 'auto-price',
        sessionId: 'auto-session-1',
        status: 'completed',
        lastMessage: '巡检完成：' + '商品价格与库存状态已更新，'.repeat(12),
        triggerType: 'schedule',
        startedAt: '2026-06-15 09:02:00',
        endedAt: '2026-06-15 09:04:31',
        createdAt: '2026-06-15 09:02:00',
        updatedAt: '2026-06-15 09:04:31',
      };
      const runWithoutArtifacts = {
        id: 'run-price-0',
        automationId: 'auto-price',
        sessionId: 'auto-session-0',
        status: 'completed',
        lastMessage: '巡检完成，本次没有生成文件或数据表。',
        triggerType: 'schedule',
        startedAt: '2026-06-14 09:02:00',
        endedAt: '2026-06-14 09:03:12',
        createdAt: '2026-06-14 09:02:00',
        updatedAt: '2026-06-14 09:03:12',
      };
      const session = {
        id: 'auto-session-1',
        title: '定时任务 · 每日竞品价格巡检',
        source: 'automation',
        automationId: 'auto-price',
        automationRunId: 'run-price-1',
        parentSessionId: '0',
        createdAt: '2026-06-15 09:02:00',
        updatedAt: '2026-06-15 09:04:31',
      };
      const storage = {
        qz_data_consent: { version: 1, acceptedAt: 1 },
        _sessions: {
          [session.id]: session,
          'auto-session-0': {
            id: 'auto-session-0',
            title: '定时任务 · 每日竞品价格巡检',
            source: 'automation',
            automationId: 'auto-price',
            automationRunId: 'run-price-0',
            parentSessionId: '0',
            createdAt: '2026-06-14 09:02:00',
            updatedAt: '2026-06-14 09:03:12',
          },
        },
        '_session_auto-session-1': {
          type: 'qz-browser-agent-session',
          version: 4,
          conversation: null,
          transcript: [
            {
              type: 'tool',
              name: 'data_store',
              toolCallId: 'data-1',
              args: { action: 'insert', table: 'competitor_price_watch', rows: [{ sku: 'A' }, { sku: 'B' }] },
              result: { action: 'insert', table: 'competitor_price_watch', totalRows: 128, columns: ['sku', 'price'] },
            },
            {
              type: 'tool',
              name: 'save_file',
              toolCallId: 'file-1',
              args: { filename: '竞品价格-20260615.csv' },
              result: { filename: '竞品价格-20260615.csv', size: 18841, downloadId: 31 },
            },
          ],
          savedAt: '2026-06-15 09:04:31',
        },
        '_session_auto-session-0': {
          type: 'qz-browser-agent-session',
          version: 4,
          conversation: null,
          transcript: [
            { type: 'assistant', text: '巡检完成，本次没有生成文件或数据表。' },
          ],
          savedAt: '2026-06-14 09:03:12',
        },
      };
      const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      const emit = (event) => listeners.message.slice().forEach(fn => fn(event));
      const storageGet = async (keys) => {
        if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
        if (keys && typeof keys === 'object') {
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(storage[key] ?? fallback)]));
        }
        return clone(storage);
      };
      const port = {
        onMessage: { addListener(fn) { listeners.message.push(fn); } },
        onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
        postMessage(msg) {
          if (msg?.type === 'list_plugin_contributions' && msg.requestId) {
            setTimeout(() => {
              listeners.message.slice().forEach(fn => fn({ type: 'plugin_contributions', requestId: msg.requestId, plugins: [], diagnostics: [], version: 1 }));
              window.__pluginCatalogResponses = (window.__pluginCatalogResponses || 0) + 1;
            }, 0);
            return;
          }
          if (!msg) return;
          if (msg.type === 'get_config') {
            setTimeout(() => emit({
              type: 'config',
              config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai' },
              presets: [],
            }), 0);
            return;
          }
          if (msg.type === 'create_ui_session' && msg.requestId) {
            setTimeout(() => emit({ requestId: msg.requestId, session: { id: 'manual-session', title: '手动任务', parentSessionId: '0' } }), 0);
            return;
          }
          if (msg.type === 'list_sessions' && msg.requestId) {
            setTimeout(() => emit({ requestId: msg.requestId, sessions: Object.values(storage._sessions) }), 0);
            return;
          }
          if (msg.type === 'list_automations' && msg.requestId) {
            setTimeout(() => emit({ requestId: msg.requestId, automations: [automation], runs: { [automation.id]: [run, runWithoutArtifacts] } }), 0);
            return;
          }
        },
      };
      window.chrome = {
        runtime: {
          connect() { return port; },
          getURL(path) { return '/extension/' + path; },
          sendMessage() {},
        },
        storage: {
          local: {
            get: storageGet,
            async set(values) { Object.assign(storage, clone(values || {})); },
            async remove(keys) {
              (Array.isArray(keys) ? keys : [keys]).filter(Boolean).forEach(key => delete storage[key]);
            },
          },
          onChanged: { addListener(fn) { listeners.changed.push(fn); } },
        },
        permissions: { async request({ permissions }) { return permissions.every(value => value === 'downloads.open'); } },
        downloads: {
          async download(opts) { window.__downloadedArtifactOpts = opts || {}; },
          async search() { return []; },
          open(id) { window.__openedDownloadId = id; },
          show(id) { window.__shownDownloadId = id; },
        },
        tabs: { async query() { return []; }, async create() { return {}; } },
        desktopCapture: { chooseDesktopMedia() {} },
      };
    })();
    """)
    try:
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.wait_for_selector("#input")
        page.wait_for_selector('.tab-btn[data-tab="sessions"]')
        page.evaluate("""() => document.querySelector('.tab-btn[data-tab="sessions"]')?.click()""")
        page.wait_for_selector("#sessions-panel:not(.hidden)")
        page.wait_for_selector('.sessions-mode-btn[data-sessions-mode="automation"]')
        page.evaluate("""() => document.querySelector('.sessions-mode-btn[data-sessions-mode="automation"]')?.click()""")
        page.wait_for_selector(".automation-card")
        page.wait_for_function("document.querySelector('.automation-artifact-mark')?.innerText.includes('2')")
        card_text = page.locator(".automation-card").first.inner_text()
        expect("每日竞品价格巡检" in card_text and "产物" in card_text and "2" in card_text, f"automation artifacts: card should expose latest artifact count {card_text}")
        expect(page.locator(".automation-artifact-line").count() == 1, "automation artifacts: card should expose a compact latest artifact line")

        page.click(".automation-expand-btn")
        run_title = page.locator(".automation-run-title").first.inner_text()
        expect(len(run_title) == 87 and run_title.startswith("巡检完成：") and "最近" not in run_title, f"automation run should show an 87-character latest message without a 最近 prefix {run_title}")
        empty_run = page.locator(".automation-run").nth(1)
        expect(empty_run.locator(".automation-run-artifacts").count() == 0 and "无产物" not in empty_run.inner_text(), "automation runs without artifacts should not render an artifact label or placeholder")
        page.wait_for_selector(".automation-artifact-shelf")
        shelf_text = page.locator(".automation-artifact-shelf").inner_text()
        expect("最近一次产物" in shelf_text and "简报" not in shelf_text and "竞品价格-20260615.csv" in shelf_text and "competitor_price_watch" in shelf_text, f"automation artifacts: shelf content mismatch {shelf_text}")
        expect(page.locator(".automation-artifact-row[data-artifact-action='open-file']").count() == 1, "automation artifacts: file row should be directly openable")
        page.click(".automation-artifact-row[data-artifact-action='open-file']")
        page.wait_for_function("window.__openedDownloadId === 31")
        page.wait_for_function("window.__pluginCatalogResponses > 0")
        expect(not page_errors, "automation artifacts page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "automation artifacts console errors: " + json.dumps(console_errors, ensure_ascii=False))
    finally:
        page.close()


def parse_args():
    parser = ArgumentParser(description="Render and record the tool timeline visual testsuite.")
    parser.add_argument("legacy_screenshot", nargs="?", help="Backward-compatible screenshot path.")
    parser.add_argument("--screenshot", help="PNG screenshot output path.")
    parser.add_argument("--gif", nargs="?", const=str(DEFAULT_GIF), help="GIF output path.")
    parser.add_argument("--conversation", help="Conversation flow JSON file.")
    parser.add_argument("--operations", help="Operation flow JSON file.")
    parser.add_argument("--scenario", help="Render a built-in scenario before screenshot, e.g. long.")
    parser.add_argument("--all-tools", action="store_true", help="Run every standalone tool component interaction check.")
    parser.add_argument("--skip-checks", action="store_true", help="Skip built-in assertions.")
    parser.add_argument("--fps", type=int, default=3, help="GIF frame rate.")
    parser.add_argument("--frame-target", choices=["page", "device"], default="page", help="GIF capture target.")
    return parser.parse_args()


def main():
    args = parse_args()
    screenshot_path = Path(args.screenshot or args.legacy_screenshot or DEFAULT_SCREENSHOT)
    gif_path = Path(args.gif) if args.gif else None
    conversation_flow = read_json(args.conversation)
    operation_flow = read_json(args.operations)

    with serve_sidepanel() as url, sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"))
        page = browser.new_page(locale="zh-CN", viewport={"width": 1180, "height": 980}, device_scale_factor=1)
        page_errors = []
        console_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.goto(url)
        page.wait_for_selector(".msg-tool-timeline")

        results = []
        component_results = None
        edge_case_results = None
        if not args.skip_checks and conversation_flow is None:
            results = run_builtin_checks(page)
            edge_case_results = run_edge_case_matrix(page)
            expect_sidepanel_settings_smoke(browser, url)
            expect_sidepanel_session_delete_stability(browser, url)
            expect_sidepanel_assistant_actions_smoke(browser, url)
            expect_sidepanel_artifacts_smoke(browser, url)
            expect_sidepanel_automation_artifacts_smoke(browser, url)
            if args.all_tools:
                component_results = run_all_tool_component_checks(page)
            else:
                page.click('[data-scenario="mixed"]')
        elif args.all_tools:
            component_results = run_all_tool_component_checks(page)

        apply_conversation_flow(page, conversation_flow)
        if conversation_flow is None:
            apply_scenario(page, args.scenario)
        if conversation_flow is not None:
            page.click("#expand-all")
        elif args.all_tools:
            page.evaluate("() => window.visualTimelineTest.setAllToolCardsExpanded(true)")
        else:
            page.click("#expand-all")
        page.wait_for_timeout(250)

        expect(not page_errors, "page errors: " + json.dumps(page_errors, ensure_ascii=False))
        expect(not console_errors, "console errors: " + json.dumps(console_errors, ensure_ascii=False))
        page.screenshot(path=screenshot_path, full_page=True)

        if gif_path:
            operations = operation_flow or default_operations_from_page(page)
            with tempfile.TemporaryDirectory(prefix="qingzhou-timeline-frames-") as tmp:
                frame_dir = Path(tmp)
                run_operations_with_frames(page, operations, frame_dir, args.frame_target)
                make_gif(frame_dir, gif_path, args.fps)

        browser.close()

    case_count = len(results)
    if edge_case_results:
        case_count += edge_case_results.get("cases", 0)
    if component_results:
        case_count += component_results.get("components", 0)
    if args.all_tools and not args.skip_checks and conversation_flow is None:
        expect(case_count >= 200, f"expected at least 200 visual test cases, got {case_count}")

    print(json.dumps({
        "ok": True,
        "url": url,
        "screenshot": str(screenshot_path),
        "gif": str(gif_path) if gif_path else "",
        "caseCount": case_count,
        "results": results,
        "edgeCaseResults": edge_case_results,
        "componentResults": component_results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
