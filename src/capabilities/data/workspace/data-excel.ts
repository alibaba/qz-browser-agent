import { t } from "../i18n.js";
import type * as XLSX from "xlsx";

let pending: Promise<typeof XLSX> | undefined;

/** Load the readable ESM distribution only for spreadsheet I/O, never for plain-text parsing. */
export function loadExcel() {
  return pending ||= import("xlsx").catch(error => {
    pending = undefined;
    throw new Error(t("couldNotLoadExcelSupportReopenTheSidePanel"), { cause: error });
  });
}
