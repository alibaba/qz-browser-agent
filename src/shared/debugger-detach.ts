import { defineMessages } from "./i18n/definition.js";
import { createTranslator } from "./i18n/index.js";

export const debuggerDetachMessages = defineMessages("debugger-detach", {
  title: { "zh-CN": "已断开调试", en: "Debugging disconnected" },
  message: { "zh-CN": "你关闭了「正在调试此浏览器」提示，调试连接已断开。要继续这个任务吗？", en: "You dismissed the \u201cdebugging this browser\u201d bar, so the debugger connection was closed. Continue this task?" },
  continue: { "zh-CN": "继续", en: "Continue" },
  stop: { "zh-CN": "停止", en: "Stop" },
});

export const debuggerDetachT = createTranslator(debuggerDetachMessages);
