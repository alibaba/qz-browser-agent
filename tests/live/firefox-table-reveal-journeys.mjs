import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setColorScheme, setSidebarWidth } from "../firefox/driver.mjs";
import { analyzeAssistantStreamFrames } from "../support/assistant-stream-fuzz.mjs";
import { checkLiveTableReveal } from "../support/live-table-reveal.mjs";

const scenarios = [
  { id: "firefox-accessible-forms", width: 380, theme: "dark", terms: ["label", "fieldset"],
    prompt: "阅读 https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/How_to_structure_a_web_form，给活动报名表设计无障碍改进方案，比较 label、fieldset、legend、button、input 和错误提示的职责。" },
  { id: "firefox-python-dates", width: 500, theme: "light", terms: ["datetime", "zoneinfo"],
    prompt: "读取 https://docs.python.org/3/library/datetime.html 和 https://docs.python.org/3/library/zoneinfo.html，给跨时区会议排期系统写技术建议，比较 date、time、datetime、timedelta、timezone、ZoneInfo 的职责和陷阱。" },
  { id: "firefox-media-accessibility", width: 390, theme: "light", terms: ["caption", "transcript"],
    prompt: "我们要发布含演讲、屏幕操作和环境声音的教学视频。读取 https://www.w3.org/WAI/media/av/captions/ 和 https://www.w3.org/WAI/media/av/transcripts/，设计字幕 captions 与文字转录 transcripts 的交付清单，说明说话人、重要音效、画面信息、时序、格式和验收方式；明确哪些信息须由人工补充。" },
  { id: "firefox-space-observatories", width: 520, theme: "dark", terms: ["Webb", "Hubble", "Chandra"],
    prompt: "给中学生天文社设计一节多波段观测课。读取 https://science.nasa.gov/mission/webb/、https://science.nasa.gov/mission/hubble/ 和 https://science.nasa.gov/mission/chandra/，比较 Webb、Hubble、Chandra 的观测波段、目标、位置和互补关系，区分官网事实与教学类比，给出六个可讨论的问题。不要凭记忆填官网未提供的参数。" },
];

export async function runFirefoxTableRevealJourneys({ session, sidebar, call, finish, output, report, save }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const selected = scenarios.filter(scenario => !process.env.QINGZHOU_LIVE_UI_CASES
    || process.env.QINGZHOU_LIVE_UI_CASES.split(',').includes(scenario.id));
  assert.ok(selected.length, 'At least one Firefox journey must be selected');
  for (const scenario of selected) {
    const record = report.scenarios[scenario.id] = { ok: false, ...scenario, interactions: [] };
    let task;
    try {
      await setSidebarWidth(session, scenario.width);
      await setColorScheme(session, scenario.theme);
      record.prompt += " 请实际开页并读取后作答。最终回答先写约 300 字背景，再给至少 6 行的 Markdown 对照表格，之后写约 1000 字具体建议，最后附带链接的脚注来源。工具执行前不要输出长说明。";
      task = await call("start", record.prompt);
      record.sessionId = task.sessionId;
      await sidebar("view.__startLiveTableProbe(); return true;");
      const deadline = Date.now() + 180000;
      let ready = false;
      while (Date.now() < deadline) {
        ready = await sidebar(`return !!content.document.querySelector('.tool-summary') && [...content.document.querySelectorAll('.msg-assistant[data-markdown-mode="stream"]')].some(el=>(el.dataset.content?.length||0)>180);`);
        if (ready || await call("finished", task)) break;
        await wait(150);
      }
      assert.ok(ready, "Live assistant text must overlap the tool-card interactions");
      for (let i = 0; i < 3; i++) {
        await sidebar("content.document.querySelector('#messages .tool-summary').click(); return true;");
        record.interactions.push({ action: "toggle-tool", running: !await call("finished", task) });
        await wait(100);
      }
      await sidebar(`
        const doc=content.document, summary=doc.querySelector('#messages .tool-summary'), m=doc.querySelector('#messages');
        if(summary.getAttribute('aria-expanded')!=='true')summary.click();
        view.__liveTables.phase='interaction';
        m.dispatchEvent(new content.WheelEvent('wheel',{deltaY:-10000,bubbles:true}));
        m.scrollTop=0; return true;
      `);
      await wait(300);
      await sidebar(`const p=view.__liveTables; p.anchor=content.document.querySelector('#messages .msg-user'); p.baseline=p.anchor.getBoundingClientRect().top; p.phase='reading'; return true;`);
      await wait(800);
      await sidebar(`const p=view.__liveTables,m=content.document.querySelector('#messages');p.phase='interaction';m.dispatchEvent(new content.WheelEvent('wheel',{deltaY:10000,bubbles:true}));m.scrollTop=m.scrollHeight;return true;`);
      await wait(350);
      await sidebar("view.__liveTables.phase='tail';return true;");
      const done = await finish(task);
      await wait(400);
      const probe = await sidebar("return view.__liveTables.stop();");
      await writeFile(join(output, `${scenario.id}-frames.json`), JSON.stringify(probe));
      await writeFile(join(output, `${scenario.id}-trajectory.json`), JSON.stringify({ prompt: record.prompt, ...done }, null, 2));
      record.answer = done.answer;
      record.tableReveal = checkLiveTableReveal(probe);
      const stability = analyzeAssistantStreamFrames(probe.frames);
      record.stability = stability;
      assert.deepEqual(stability.failures, []);
      assert.ok(stability.coverage.tailContentChanges > 0);
      for (const term of scenario.terms) assert.ok(done.answer.toLowerCase().includes(term.toLowerCase()), term);
      const ends = done.events.filter(event => event.type === 'tool_execution_end');
      record.tools = ends.map(event => ({ name: event.toolName, error: !!event.isError }));
      assert.ok(ends.some(event => event.toolName === 'open_tab'));
      assert.ok(ends.some(event => event.toolName === 'read_article'));
      assert.equal(ends.filter(event => event.isError).length, 0);
      const screenshot = await sidebar(`
        const doc=content.document;
        await new Promise(resolve=>content.requestAnimationFrame(resolve));
        await new Promise(resolve=>content.requestAnimationFrame(resolve));
        const canvas=doc.createElementNS('http://www.w3.org/1999/xhtml','canvas');
        canvas.width=content.innerWidth;canvas.height=content.innerHeight;
        canvas.getContext('2d').drawWindow(content,0,0,canvas.width,canvas.height,'white');
        return canvas.toDataURL('image/png').split(',')[1];
      `).catch(error => { record.screenshotError = String(error.message); return null; });
      if (screenshot) await writeFile(join(output, `${scenario.id}-completed.png`), Buffer.from(screenshot, 'base64'));
      record.ok = true;
      console.log(`PASS live ${scenario.id}: ${ends.length} tools, ${probe.frames.length} frames`);
    } catch (error) {
      record.error = String(error.stack || error);
      console.log(`FAIL live ${scenario.id}: ${error.message}`);
      const probe = await sidebar("return view.__liveTables?.stop();").catch(() => null);
      if (probe) await writeFile(join(output, `${scenario.id}-failure-frames.json`), JSON.stringify(probe));
      const events = await call("events", task?.after || 0).catch(() => []);
      await writeFile(join(output, `${scenario.id}-failure-events.json`), JSON.stringify(events, null, 2));
    } finally {
      if (task && !await call("finished", task)) await call("request", "stop_session", {sessionId: task.sessionId}, "state");
      await save();
    }
  }
  assert.ok(Object.values(report.scenarios).every(record => record.ok), "Firefox table reveal journeys must all pass");
  assert.ok(report.requests.some(request => request.chunks > 1), "Must observe real DeepSeek streaming");
}
