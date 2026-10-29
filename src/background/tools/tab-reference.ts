import { isTabAlias, tabReferenceId } from "../../shared/tab-reference.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "./arguments.js";
import { t } from "./messages.js";

const keys: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  invalid_alias: "batchTabReferenceInvalidAlias", duplicate_alias: "batchTabReferenceDuplicateAlias",
  invalid_reference: "batchTabReferenceInvalidReference", unknown_reference: "batchTabReferenceUnknownReference",
  forward_reference: "batchTabReferenceForwardReference", ambiguous_target: "batchTabReferenceAmbiguousTarget",
  conflicting_target: "tabReferenceConflict",
};
export function tabReferenceError(reason: string, reference?: unknown, language = getLanguage()) {
  const dependency = reason === "dependency_failed";
  return new ToolExecutionError(dependency ? "BATCH_TAB_DEPENDENCY_FAILED" : "BATCH_TAB_REFERENCE_ERROR",
    withLanguage(language, () => t(dependency ? "batchTabDependencyFailed" : keys[reason] || "batchTabReferenceError",
      { tabRef: reference == null ? (language === "zh-CN" ? "（未知）" : "unknown") : String(reference) })),
    { reason, ...(reference == null ? {} : { tabRef: reference }) });
}

export function resolveTabReference(ref: unknown, aliases: Readonly<Record<string, number>>, language = getLanguage()): number {
  const id = tabReferenceId(ref);
  if (id !== null) return id;
  if (!isTabAlias(ref)) throw tabReferenceError("invalid_reference", ref, language);
  if (!Object.hasOwn(aliases, ref)) throw tabReferenceError("unknown_reference", ref, language);
  return aliases[ref];
}
