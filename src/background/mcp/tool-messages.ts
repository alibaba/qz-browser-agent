import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Drive-specific availability; tool descriptions come from their declarations. */
const messages = defineMessages("drive-tools", {
  unavailable: {
    "zh-CN": "此工具不对直驱开放。请查询可用工具；页面操作显式传入 tabRef。",
    en: "This tool is unavailable in direct drive. Query the available tools and pass tabRef explicitly for page operations.",
  },
});
export const driveToolText = createTranslator(messages);
