import { getLanguage } from "../i18n/index.js";
import { t, type BackendMessageKey } from "../i18n/backend.js";
interface FailureContext { code?: unknown; details?: unknown; toolName?: unknown; isError?: boolean }
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

const CJK_RE = /[\u3400-\u9fff]/;
const UPPER_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]+$/;

// Each error owns its label and optional fixed recovery message; contextual messages stay below.
const ERROR_CATALOG: Readonly<Record<string, { label: BackendMessageKey; message?: BackendMessageKey }>> = Object.freeze({
  SKILL_SELECTION_INVALID_ITEMS: { label: "toolError.SKILL_SELECTION_INVALID_ITEMS.label", message: "toolError.SKILL_SELECTION_INVALID_ITEMS.message" },
  SKILL_SELECTION_INVALID_ANSWER: { label: "toolError.SKILL_SELECTION_INVALID_ANSWER.label", message: "toolError.SKILL_SELECTION_INVALID_ANSWER.message" },
  LOCATION_CONSENT_REQUIRED: { label: "locationRequired", message: "locationRequired" },
  LOCATION_UNAVAILABLE: { label: "locationUnavailableLabel", message: "locationUnavailable" },
  LOCATION_PERMISSION_DENIED: { label: "locationPermissionDeniedLabel", message: "locationPermissionDenied" },
  LOCATION_POSITION_UNAVAILABLE: { label: "locationPositionUnavailableLabel", message: "locationPositionUnavailable" },
  LOCATION_TIMEOUT: { label: "locationTimeoutLabel", message: "locationTimeout" },
  LOCATION_PANEL_UNAVAILABLE: { label: "locationPanelUnavailableLabel", message: "locationPanelUnavailable" },
  LOCATION_RESPONSE_TIMEOUT: { label: "locationResponseTimeoutLabel", message: "locationResponseTimeout" },
  ABORTED: { label: "toolError.ABORTED.label", message: "toolError.ABORTED.message" },
  AGENT_ALREADY_RUNNING: { label: "toolError.AGENT_ALREADY_RUNNING.label" },
  SESSION_PERSIST_FAILED: { label: "toolError.SESSION_PERSIST_FAILED.label" },
  STALE_AGENT_LEASE: { label: "toolError.STALE_AGENT_LEASE.label" },
  RUN_ABORTED_BEFORE_START: { label: "toolError.RUN_ABORTED_BEFORE_START.label" },
  EMPTY_LLM_RESPONSE: { label: "toolError.EMPTY_LLM_RESPONSE.label" },
  FILE_ACCESS_REQUIRED: { label: "toolError.FILE_ACCESS_REQUIRED.label", message: "toolError.FILE_ACCESS_REQUIRED.message" },
  UNSUPPORTED_URL: { label: "toolError.UNSUPPORTED_URL.label", message: "toolError.UNSUPPORTED_URL.message" },
  GIT_REPOSITORY_TAB_FAILED: { label: "toolError.GIT_REPOSITORY_TAB_FAILED.label" },
  INVALID_CONTENT_RESPONSE: { label: "toolError.INVALID_CONTENT_RESPONSE.label" },
  AGENT_RUN_FAILED: { label: "toolError.AGENT_RUN_FAILED.label" },
  AGENT_FINALIZATION_FAILED: { label: "toolError.AGENT_RUN_FAILED.label" },
  AUTOMATION_RUNTIME_UNAVAILABLE: { label: "toolError.AUTOMATION_RUNTIME_UNAVAILABLE.label", message: "toolError.AUTOMATION_RUNTIME_UNAVAILABLE.message" },
  AX_ROOT_UNRESOLVED: { label: "toolError.AX_ROOT_UNRESOLVED.label" },
  CANNOT_DELETE_CALLER_SESSION: { label: "toolError.CANNOT_DELETE_CALLER_SESSION.label", message: "toolError.CANNOT_DELETE_CALLER_SESSION.message" },
  CANNOT_WAIT_CALLER_SESSION: { label: "toolError.CANNOT_WAIT_CALLER_SESSION.label", message: "toolError.CANNOT_WAIT_CALLER_SESSION.message" },
  CDP_COMMAND_FAILED: { label: "toolError.CDP_COMMAND_FAILED.label", message: "toolError.CDP_COMMAND_FAILED.message" },
  CDP_RUN_CONTEXT_REQUIRED: { label: "toolError.CDP_RUN_CONTEXT_REQUIRED.label", message: "toolError.CDP_RUN_CONTEXT_REQUIRED.message" },
  CDP_REATTACH_WAIT_CONFLICT: { label: "toolError.CDP_REATTACH_WAIT_CONFLICT.label", message: "toolError.CDP_REATTACH_WAIT_CONFLICT.message" },
  CDP_RUN_RELEASED: { label: "toolError.CDP_RUN_RELEASED.label", message: "toolError.CDP_RUN_RELEASED.message" },
  CDP_SESSION_RUNTIME_UNAVAILABLE: { label: "toolError.CDP_SESSION_RUNTIME_UNAVAILABLE.label", message: "toolError.CDP_SESSION_RUNTIME_UNAVAILABLE.message" },
  CDP_TAB_LEASE_CONFLICT: { label: "toolError.CDP_TAB_LEASE_CONFLICT.label", message: "toolError.CDP_TAB_LEASE_CONFLICT.message" },
  CONTENT_SCRIPT_MESSAGE_FAILED: { label: "toolError.CONTENT_SCRIPT_MESSAGE_FAILED.label", message: "toolError.CONTENT_SCRIPT_MESSAGE_FAILED.message" },
  CONTENT_SCRIPT_NOT_READY: { label: "toolError.CONTENT_SCRIPT_NOT_READY.label", message: "toolError.CONTENT_SCRIPT_NOT_READY.message" },
  DATA_DESTRUCTIVE_ACTION_DISABLED: { label: "toolError.DATA_DESTRUCTIVE_ACTION_DISABLED.label", message: "toolError.DATA_DESTRUCTIVE_ACTION_DISABLED.message" },
  DATA_ROW_CONFLICT: { label: "toolError.DATA_ROW_CONFLICT.label", message: "toolError.DATA_ROW_CONFLICT.message" },
  DATA_ROW_NOT_FOUND: { label: "toolError.DATA_ROW_NOT_FOUND.label", message: "toolError.DATA_ROW_NOT_FOUND.message" },
  DATA_ROW_PRECONDITION_REQUIRED: { label: "toolError.DATA_ROW_PRECONDITION_REQUIRED.label", message: "toolError.DATA_ROW_PRECONDITION_REQUIRED.message" },
  DATA_ROW_TABLE_MISMATCH: { label: "toolError.DATA_ROW_TABLE_MISMATCH.label", message: "toolError.DATA_ROW_TABLE_MISMATCH.message" },
  DEBUGGER_ATTACH_FAILED: { label: "toolError.DEBUGGER_ATTACH_FAILED.label", message: "toolError.DEBUGGER_ATTACH_FAILED.message" },
  DEBUGGER_UNAVAILABLE: { label: "toolError.DEBUGGER_UNAVAILABLE.label", message: "toolError.DEBUGGER_UNAVAILABLE.message" },
  DIAGNOSTICS_RUNTIME_NOT_READY: { label: "toolError.DIAGNOSTICS_RUNTIME_NOT_READY.label" },
  DESKTOP_CAPTURE_AUDIO_NOT_SELECTED: { label: "toolError.DESKTOP_CAPTURE_AUDIO_NOT_SELECTED.label" },
  DESKTOP_CAPTURE_FAILED: { label: "toolError.DESKTOP_CAPTURE_FAILED.label" },
  DESKTOP_CAPTURE_UNAVAILABLE: { label: "toolError.DESKTOP_CAPTURE_UNAVAILABLE.label" },
  DOCUMENT_ARTIFACT_EMPTY: { label: "toolError.DOCUMENT_ARTIFACT_EMPTY.label", message: "toolError.DOCUMENT_ARTIFACT_EMPTY.message" },
  DOCUMENT_ARTIFACT_NOT_FOUND: { label: "toolError.DOCUMENT_ARTIFACT_NOT_FOUND.label", message: "toolError.DOCUMENT_ARTIFACT_NOT_FOUND.message" },
  DOCUMENT_BLOCK_SCHEMA_INVALID: { label: "toolError.DOCUMENT_BLOCK_SCHEMA_INVALID.label" },
  DOCUMENT_CHUNK_NOT_FOUND: { label: "toolError.DOCUMENT_CHUNK_NOT_FOUND.label", message: "toolError.DOCUMENT_CHUNK_NOT_FOUND.message" },
  DOCUMENT_CONTENT_EMPTY: { label: "toolError.DOCUMENT_CONTENT_EMPTY.label", message: "toolError.DOCUMENT_CONTENT_EMPTY.message" },
  DOCUMENT_CREATE_SCHEMA_INVALID: { label: "toolError.DOCUMENT_CREATE_SCHEMA_INVALID.label", message: "toolError.DOCUMENT_CREATE_SCHEMA_INVALID.message" },
  DOCUMENT_CSV_MULTIPLE_TABLES: { label: "toolError.DOCUMENT_CSV_MULTIPLE_TABLES.label", message: "toolError.DOCUMENT_CSV_MULTIPLE_TABLES.message" },
  DOCUMENT_DIRECT_PAYLOAD_TOO_LARGE: { label: "toolError.DOCUMENT_DIRECT_PAYLOAD_TOO_LARGE.label", message: "toolError.DOCUMENT_DIRECT_PAYLOAD_TOO_LARGE.message" },
  DOCUMENT_FETCH_FAILED: { label: "toolError.DOCUMENT_FETCH_FAILED.label", message: "toolError.DOCUMENT_FETCH_FAILED.message" },
  DOCUMENT_FILE_NOT_FOUND: { label: "toolError.DOCUMENT_FILE_NOT_FOUND.label", message: "toolError.DOCUMENT_FILE_NOT_FOUND.message" },
  DOCUMENT_FORMAT_UNSUPPORTED: { label: "toolError.DOCUMENT_FORMAT_UNSUPPORTED.label", message: "toolError.DOCUMENT_FORMAT_UNSUPPORTED.message" },
  DOCUMENT_MODEL_NOT_FOUND: { label: "toolError.DOCUMENT_MODEL_NOT_FOUND.label", message: "toolError.DOCUMENT_MODEL_NOT_FOUND.message" },
  DOCUMENT_OUTPUT_EMPTY: { label: "toolError.DOCUMENT_OUTPUT_EMPTY.label", message: "toolError.DOCUMENT_OUTPUT_EMPTY.message" },
  DOCUMENT_OUTPUT_INVALID: { label: "toolError.DOCUMENT_OUTPUT_INVALID.label", message: "toolError.DOCUMENT_OUTPUT_INVALID.message" },
  DOCUMENT_SESSION_FOREIGN: { label: "toolError.DOCUMENT_SESSION_FOREIGN.label" },
  DOCUMENT_SHEET_SCHEMA_INVALID: { label: "toolError.DOCUMENT_SHEET_SCHEMA_INVALID.label" },
  DOCUMENT_SHEET_NOT_FOUND: { label: "toolError.DOCUMENT_SHEET_NOT_FOUND.label", message: "toolError.DOCUMENT_SHEET_NOT_FOUND.message" },
  DOCUMENT_SOURCE_CONFLICT: { label: "toolError.DOCUMENT_SOURCE_CONFLICT.label", message: "toolError.DOCUMENT_SOURCE_CONFLICT.message" },
  DOCUMENT_TABULAR_CONTENT_REQUIRED: { label: "toolError.DOCUMENT_TABULAR_CONTENT_REQUIRED.label", message: "toolError.DOCUMENT_TABULAR_CONTENT_REQUIRED.message" },
  DOCUMENT_TABULAR_SOURCE_CONFLICT: { label: "toolError.DOCUMENT_TABULAR_SOURCE_CONFLICT.label", message: "toolError.DOCUMENT_TABULAR_SOURCE_CONFLICT.message" },
  DOCUMENT_TABLE_NOT_FOUND: { label: "toolError.DOCUMENT_TABLE_NOT_FOUND.label", message: "toolError.DOCUMENT_TABLE_NOT_FOUND.message" },
  ELEMENT_HAS_NO_RENDERED_BOX: { label: "toolError.ELEMENT_HAS_NO_RENDERED_BOX.label", message: "toolError.ELEMENT_HAS_NO_RENDERED_BOX.message" },
  ELEMENT_RESOLVE_FAILED: { label: "toolError.ELEMENT_RESOLVE_FAILED.label", message: "toolError.ELEMENT_RESOLVE_FAILED.message" },
  ELEMENT_SCREENSHOT_EMPTY: { label: "toolError.ELEMENT_SCREENSHOT_EMPTY.label", message: "toolError.ELEMENT_SCREENSHOT_EMPTY.message" },
  ELEMENT_SCREENSHOT_BOUNDS_FAILED: { label: "toolError.ELEMENT_SCREENSHOT_BOUNDS_FAILED.label", message: "toolError.ELEMENT_SCREENSHOT_BOUNDS_FAILED.message" },
  ELEMENT_UID_SESSION_MISMATCH: { label: "toolError.ELEMENT_UID_SESSION_MISMATCH.label", message: "toolError.ELEMENT_UID_SESSION_MISMATCH.message" },
  ELEMENT_UID_TAB_MISMATCH: { label: "toolError.ELEMENT_UID_TAB_MISMATCH.label", message: "toolError.ELEMENT_UID_TAB_MISMATCH.message" },
  EMPTY_CONTENT_RESPONSE: { label: "toolError.EMPTY_CONTENT_RESPONSE.label", message: "toolError.EMPTY_CONTENT_RESPONSE.message" },
  IMAGE_ASSET_NOT_FOUND: { label: "toolError.IMAGE_ASSET_NOT_FOUND.label" },
  IMAGE_CANVAS_FAILED: { label: "toolError.IMAGE_CANVAS_FAILED.label" },
  IMAGE_COLLECTION_ALL_FAILED: { label: "toolError.IMAGE_COLLECTION_ALL_FAILED.label" },
  IMAGE_COLLECTION_READ_FAILED: { label: "toolError.IMAGE_COLLECTION_READ_FAILED.label" },
  IMAGE_ELEMENT_SCREENSHOT_UNAVAILABLE: { label: "toolError.IMAGE_ELEMENT_SCREENSHOT_UNAVAILABLE.label" },
  IMAGE_PAGE_BINARY_FAILED: { label: "toolError.IMAGE_PAGE_BINARY_FAILED.label" },
  IMAGE_SELECTION_LIMIT_EXCEEDED: { label: "toolError.IMAGE_SELECTION_LIMIT_EXCEEDED.label" },
  IMAGE_SOURCE_URL_MISSING: { label: "toolError.IMAGE_SOURCE_URL_MISSING.label" },
  IMAGE_TARGET_NOT_SINGLE: { label: "toolError.IMAGE_TARGET_NOT_SINGLE.label", message: "toolError.IMAGE_TARGET_NOT_SINGLE.message" },
  IMAGE_URL_FETCH_FAILED: { label: "toolError.IMAGE_URL_FETCH_FAILED.label", message: "toolError.IMAGE_URL_FETCH_FAILED.message" },
  IMAGE_URL_HTTP_ERROR: { label: "toolError.IMAGE_URL_HTTP_ERROR.label", message: "toolError.IMAGE_URL_HTTP_ERROR.message" },
  IMAGE_DECODE_FAILED: { label: "toolError.IMAGE_DECODE_FAILED.label" },
  IMAGE_URL_NOT_IMAGE: { label: "toolError.IMAGE_URL_NOT_IMAGE.label", message: "toolError.IMAGE_URL_NOT_IMAGE.message" },
  IMAGE_URL_TOO_LARGE: { label: "toolError.IMAGE_URL_TOO_LARGE.label", message: "toolError.IMAGE_URL_TOO_LARGE.message" },
  IMAGE_DOM_READ_FAILED: { label: "toolError.IMAGE_DOM_READ_FAILED.label" },
  INNER_RUNNER_FAILED: { label: "toolError.INNER_RUNNER_FAILED.label", message: "toolError.INNER_RUNNER_FAILED.message" },
  INNER_RUNNER_INVALID_REQUEST: { label: "toolError.INNER_RUNNER_INVALID_REQUEST.label", message: "toolError.INNER_RUNNER_INVALID_REQUEST.message" },
  INNER_RUNNER_OFFSCREEN_NOT_READY: { label: "toolError.INNER_RUNNER_OFFSCREEN_NOT_READY.label", message: "toolError.INNER_RUNNER_OFFSCREEN_NOT_READY.message" },
  INNER_RUNNER_SANDBOX_NOT_READY: { label: "toolError.INNER_RUNNER_SANDBOX_NOT_READY.label", message: "toolError.INNER_RUNNER_SANDBOX_NOT_READY.message" },
  INNER_RUNNER_SEND_FAILED: { label: "toolError.INNER_RUNNER_SEND_FAILED.label", message: "toolError.INNER_RUNNER_SEND_FAILED.message" },
  INNER_RUNNER_UNAVAILABLE: { label: "toolError.INNER_RUNNER_UNAVAILABLE.label", message: "toolError.INNER_RUNNER_UNAVAILABLE.message" },
  INNER_RUNNER_WORKER_CREATE_FAILED: { label: "toolError.INNER_RUNNER_WORKER_CREATE_FAILED.label", message: "toolError.INNER_RUNNER_WORKER_CREATE_FAILED.message" },
  INNER_RUNNER_WORKER_ERROR: { label: "toolError.INNER_RUNNER_WORKER_ERROR.label", message: "toolError.INNER_RUNNER_WORKER_ERROR.message" },
  INNER_TOOL_CALL_FAILED: { label: "toolError.INNER_TOOL_CALL_FAILED.label", message: "toolError.INNER_TOOL_CALL_FAILED.message" },
  INVALID_ARGUMENTS: { label: "toolError.INVALID_ARGUMENTS.label" },
  INVALID_BOOKMARK_ACTION: { label: "toolError.INVALID_BOOKMARK_ACTION.label" },
  INVALID_DATA_ACTION: { label: "toolError.INVALID_DATA_ACTION.label" },
  INVALID_DOCUMENT_URL: { label: "toolError.INVALID_DOCUMENT_URL.label", message: "toolError.INVALID_DOCUMENT_URL.message" },
  INVALID_ELEMENT_TARGET: { label: "toolError.INVALID_ELEMENT_TARGET.label", message: "toolError.INVALID_ELEMENT_TARGET.message" },
  INVALID_ELEMENT_SCREENSHOT_BOUNDS: { label: "toolError.INVALID_ELEMENT_SCREENSHOT_BOUNDS.label", message: "toolError.INVALID_ELEMENT_SCREENSHOT_BOUNDS.message" },
  INVALID_GUARDRAILS_ACTION: { label: "toolError.INVALID_GUARDRAILS_ACTION.label" },
  INVALID_GUARDRAIL_RATE_LIMIT: { label: "toolError.INVALID_GUARDRAIL_RATE_LIMIT.label" },
  INVALID_GUARDRAIL_RATE_LIMIT_TARGET: { label: "toolError.INVALID_GUARDRAIL_RATE_LIMIT_TARGET.label" },
  INVALID_GUARDRAIL_RULE: { label: "toolError.INVALID_GUARDRAIL_RULE.label" },
  INVALID_HISTORY_ACTION: { label: "toolError.INVALID_HISTORY_ACTION.label" },
  INVALID_IMAGE_URL: { label: "toolError.INVALID_IMAGE_URL.label", message: "toolError.INVALID_IMAGE_URL.message" },
  INVALID_IMAGE_ASSET_ACTION: { label: "toolError.INVALID_IMAGE_ASSET_ACTION.label" },
  INVALID_LONG_PRESS_DURATION: { label: "toolError.INVALID_LONG_PRESS_DURATION.label" },
  INVALID_REGEX: { label: "toolError.INVALID_REGEX.label", message: "toolError.INVALID_REGEX.message" },
  INVALID_RUN_SCRIPT_INPUT: { label: "toolError.INVALID_RUN_SCRIPT_INPUT.label", message: "toolError.INVALID_RUN_SCRIPT_INPUT.message" },
  INVALID_RUN_SCRIPT_TARGET: { label: "toolError.INVALID_RUN_SCRIPT_TARGET.label", message: "toolError.INVALID_RUN_SCRIPT_TARGET.message" },
  INVALID_SCREEN_COORDINATE: { label: "toolError.INVALID_SCREEN_COORDINATE.label", message: "toolError.INVALID_SCREEN_COORDINATE.message" },
  INVALID_SCROLL_REPEAT: { label: "toolError.INVALID_SCROLL_REPEAT.label" },
  INVALID_RUN_SKILL_SCRIPT_INPUT: { label: "toolError.INVALID_RUN_SKILL_SCRIPT_INPUT.label", message: "toolError.INVALID_RUN_SKILL_SCRIPT_INPUT.message" },
  INVALID_SETTINGS_ACTION: { label: "toolError.INVALID_SETTINGS_ACTION.label" },
  INVALID_SKILL_SETTINGS_ACTION: { label: "toolError.INVALID_SKILL_SETTINGS_ACTION.label" },
  INVALID_SESSION_ACTION: { label: "toolError.INVALID_SESSION_ACTION.label" },
  INVALID_TIMEOUT: { label: "toolError.INVALID_TIMEOUT.label" },
  INVALID_WAIT_UNTIL: { label: "toolError.INVALID_WAIT_UNTIL.label", message: "toolError.INVALID_WAIT_UNTIL.message" },
  LIST_IMAGES_FAILED: { label: "toolError.LIST_IMAGES_FAILED.label" },
  LLM_CALL_FAILED: { label: "toolError.LLM_CALL_FAILED.label" },
  MEDIA_RUNTIME_NOT_READY: { label: "toolError.MEDIA_RUNTIME_NOT_READY.label" },
  GOAL_SESSION_FORBIDDEN: { label: "toolError.GOAL_SESSION_FORBIDDEN.label", message: "toolError.GOAL_SESSION_FORBIDDEN.message" },
  GOAL_RUNTIME_UNAVAILABLE: { label: "toolError.GOAL_RUNTIME_UNAVAILABLE.label", message: "toolError.GOAL_RUNTIME_UNAVAILABLE.message" },
  MISSING_AUTOMATION_ID: { label: "toolError.MISSING_AUTOMATION_ID.label" },
  MISSING_AUTOMATION_TITLE: { label: "toolError.MISSING_AUTOMATION_TITLE.label", message: "toolError.MISSING_AUTOMATION_TITLE.message" },
  MISSING_AUTOMATION_INSTRUCTION: { label: "toolError.MISSING_AUTOMATION_INSTRUCTION.label", message: "toolError.MISSING_AUTOMATION_INSTRUCTION.message" },
  MISSING_BOOKMARK_CHANGES: { label: "toolError.MISSING_BOOKMARK_CHANGES.label", message: "toolError.MISSING_BOOKMARK_CHANGES.message" },
  MISSING_BOOKMARK_DATA: { label: "toolError.MISSING_BOOKMARK_DATA.label", message: "toolError.MISSING_BOOKMARK_DATA.message" },
  MISSING_BOOKMARK_DESTINATION: { label: "toolError.MISSING_BOOKMARK_DESTINATION.label", message: "toolError.MISSING_BOOKMARK_DESTINATION.message" },
  MISSING_BOOKMARK_ID: { label: "toolError.MISSING_BOOKMARK_ID.label", message: "toolError.MISSING_BOOKMARK_ID.message" },
  MISSING_DATA_ROW_ID: { label: "toolError.MISSING_DATA_ROW_ID.label", message: "toolError.MISSING_DATA_ROW_ID.message" },
  MISSING_ELEMENT_REFERENCE: { label: "toolError.MISSING_ELEMENT_REFERENCE.label", message: "toolError.MISSING_ELEMENT_REFERENCE.message" },
  MISSING_GOAL: { label: "toolError.MISSING_GOAL.label", message: "toolError.MISSING_GOAL.message" },
  MISSING_IMAGE_URL: { label: "toolError.MISSING_IMAGE_URL.label", message: "toolError.MISSING_IMAGE_URL.message" },
  MISSING_IMAGE_SELECTION: { label: "toolError.MISSING_IMAGE_SELECTION.label", message: "toolError.MISSING_IMAGE_SELECTION.message" },
  MISSING_KEY: { label: "toolError.MISSING_KEY.label", message: "toolError.MISSING_KEY.message" },
  MISSING_QUERY: { label: "toolError.MISSING_QUERY.label", message: "toolError.MISSING_QUERY.message" },
  MISSING_PRESET_ID: { label: "toolError.MISSING_PRESET_ID.label" },
  MISSING_REQUIRED_ARGUMENTS: { label: "toolError.MISSING_REQUIRED_ARGUMENTS.label" },
  MISSING_SETTINGS_UPDATE: { label: "toolError.MISSING_SETTINGS_UPDATE.label" },
  MISSING_SKILL_SETTINGS_UPDATE: { label: "toolError.MISSING_SKILL_SETTINGS_UPDATE.label" },
  MISSING_SESSION_ID: { label: "toolError.MISSING_SESSION_ID.label" },
  MISSING_SESSION_IDS: { label: "toolError.MISSING_SESSION_IDS.label", message: "toolError.MISSING_SESSION_IDS.message" },
  MISSING_SELECTOR: { label: "toolError.MISSING_SELECTOR.label" },
  MISSING_TAB_ID: { label: "toolError.MISSING_TAB_ID.label", message: "toolError.MISSING_TAB_ID.message" },
  MISSING_TOOL_NAME: { label: "toolError.MISSING_TOOL_NAME.label", message: "toolError.MISSING_TOOL_NAME.message" },
  MCP_SDK_ERROR: { label: "toolError.MCP_SDK_ERROR.label" },
  MCP_SERVER_AMBIGUOUS: { label: "toolError.MCP_SERVER_AMBIGUOUS.label" },
  MCP_SERVER_DISABLED: { label: "toolError.MCP_SERVER_DISABLED.label" },
  MCP_SERVER_NOT_FOUND: { label: "toolError.MCP_SERVER_NOT_FOUND.label" },
  MCP_SERVER_URL_INVALID: { label: "toolError.MCP_SERVER_URL_INVALID.label" },
  MCP_TOOL_NAME_REQUIRED: { label: "toolError.MCP_TOOL_NAME_REQUIRED.label" },
  MCP_TOOL_NOT_FOUND: { label: "toolError.MCP_TOOL_NOT_FOUND.label" },
  MODEL_CAPABILITIES_REQUIRED: { label: "toolError.MODEL_CAPABILITIES_REQUIRED.label" },
  NETWORK_BODY_UNAVAILABLE: { label: "toolError.NETWORK_BODY_UNAVAILABLE.label", message: "toolError.NETWORK_BODY_UNAVAILABLE.message" },
  NETWORK_REQUEST_NOT_FOUND: { label: "toolError.NETWORK_REQUEST_NOT_FOUND.label", message: "toolError.NETWORK_REQUEST_NOT_FOUND.message" },
  NOT_WEB_TAB: { label: "toolError.NOT_WEB_TAB.label" },
  NO_ACTIVE_TAB: { label: "toolError.NO_ACTIVE_TAB.label", message: "toolError.NO_ACTIVE_TAB.message" },
  NO_ACTIVE_WEB_TAB: { label: "toolError.NO_ACTIVE_WEB_TAB.label", message: "toolError.NO_ACTIVE_WEB_TAB.message" },
  NO_CLICKABLE_POINT: { label: "toolError.NO_CLICKABLE_POINT.label", message: "toolError.NO_CLICKABLE_POINT.message" },
  NO_WORKING_WEB_TAB: { label: "toolError.NO_WORKING_WEB_TAB.label" },
  OFFSCREEN_API_UNAVAILABLE: { label: "toolError.OFFSCREEN_API_UNAVAILABLE.label" },
  BROWSER_PERMISSION_REQUIRED: { label: "toolError.BROWSER_PERMISSION_REQUIRED.label" },
  BROWSER_PERMISSION_DENIED: { label: "toolError.BROWSER_PERMISSION_DENIED.label" },
  OPERATION_ABORTED: { label: "toolError.OPERATION_ABORTED.label", message: "toolError.OPERATION_ABORTED.message" },
  PAGE_CONTEXT_UNAVAILABLE: { label: "toolError.PAGE_CONTEXT_UNAVAILABLE.label", message: "toolError.PAGE_CONTEXT_UNAVAILABLE.message" },
  PAGE_SKILL_ZIP_DOWNLOAD_FAILED: { label: "toolError.PAGE_SKILL_ZIP_DOWNLOAD_FAILED.label" },
  PAGE_SKILL_ZIP_DUPLICATE: { label: "toolError.PAGE_SKILL_ZIP_DUPLICATE.label" },
  PAGE_SKILL_ZIP_EMPTY: { label: "toolError.PAGE_SKILL_ZIP_EMPTY.label" },
  PAGE_SKILL_ZIP_INVALID: { label: "toolError.PAGE_SKILL_ZIP_INVALID.label" },
  PAGE_SKILL_ZIP_TAB_REQUIRED: { label: "toolError.PAGE_SKILL_ZIP_TAB_REQUIRED.label" },
  PAGE_SKILL_ZIP_URL_INVALID: { label: "toolError.PAGE_SKILL_ZIP_URL_INVALID.label" },
  PAGE_OVERVIEW_FAILED: { label: "toolError.PAGE_OVERVIEW_FAILED.label", message: "toolError.PAGE_OVERVIEW_FAILED.message" },
  PDF_PRINT_FAILED: { label: "toolError.PDF_PRINT_FAILED.label", message: "toolError.PDF_PRINT_FAILED.message" },
  PDF_TAB_CREATE_FAILED: { label: "toolError.PDF_TAB_CREATE_FAILED.label", message: "toolError.PDF_TAB_CREATE_FAILED.message" },
  PLUGIN_DISPATCHER_UNAVAILABLE: { label: "toolError.PLUGIN_DISPATCHER_UNAVAILABLE.label", message: "toolError.PLUGIN_DISPATCHER_UNAVAILABLE.message" },
  PLUGIN_HOST_ACTION_UNAVAILABLE: { label: "toolError.PLUGIN_HOST_ACTION_UNAVAILABLE.label" },
  PLUGIN_HOST_SCRIPT_FAILED: { label: "toolError.PLUGIN_HOST_SCRIPT_FAILED.label" },
  PLUGIN_HOST_SCRIPT_MISSING: { label: "toolError.PLUGIN_HOST_SCRIPT_MISSING.label" },
  PLUGIN_MCP_SERVER_DISABLED: { label: "toolError.PLUGIN_MCP_SERVER_DISABLED.label" },
  PLUGIN_MCP_SERVER_UNAVAILABLE: { label: "toolError.PLUGIN_MCP_SERVER_UNAVAILABLE.label" },
  PLUGIN_NOT_FOUND: { label: "toolError.PLUGIN_NOT_FOUND.label" },
  PLUGIN_TOOL_SCRIPT_MISSING: { label: "toolError.PLUGIN_TOOL_SCRIPT_MISSING.label" },
  RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED: { label: "toolError.RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED.label", message: "toolError.RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED.message" },
  RUN_SCRIPT_TARGET_TAB_REQUIRED: { label: "toolError.RUN_SCRIPT_TARGET_TAB_REQUIRED.label", message: "toolError.RUN_SCRIPT_TARGET_TAB_REQUIRED.message" },
  RUN_SCRIPT_TOOL_CALL_FAILED: { label: "toolError.RUN_SCRIPT_TOOL_CALL_FAILED.label", message: "toolError.RUN_SCRIPT_TOOL_CALL_FAILED.message" },
  RUN_SCRIPT_TOOL_DEPTH_EXCEEDED: { label: "toolError.RUN_SCRIPT_TOOL_DEPTH_EXCEEDED.label", message: "toolError.RUN_SCRIPT_TOOL_DEPTH_EXCEEDED.message" },
  RUN_STOPPED: { label: "toolError.RUN_STOPPED.label", message: "toolError.RUN_STOPPED.message" },
  SCRIPT_EVALUATION_FAILED: { label: "toolError.SCRIPT_EVALUATION_FAILED.label", message: "toolError.SCRIPT_EVALUATION_FAILED.message" },
  SCRIPT_EXECUTION_UNAVAILABLE: { label: "toolError.SCRIPT_EXECUTION_UNAVAILABLE.label", message: "toolError.SCRIPT_EXECUTION_UNAVAILABLE.message" },
  SCRIPT_SYNTAX_ERROR: { label: "toolError.SCRIPT_SYNTAX_ERROR.label", message: "toolError.SCRIPT_SYNTAX_ERROR.message" },
  SECURITY_GUARDRAIL_BLOCKED: { label: "toolError.SECURITY_GUARDRAIL_BLOCKED.label" },
  SCREENSHOT_CONTEXT_STALE: { label: "toolError.SCREENSHOT_CONTEXT_STALE.label", message: "toolError.SCREENSHOT_CONTEXT_STALE.message" },
  SCREENSHOT_COORDINATES_UNAVAILABLE: { label: "toolError.SCREENSHOT_COORDINATES_UNAVAILABLE.label", message: "toolError.SCREENSHOT_COORDINATES_UNAVAILABLE.message" },
  SCREENSHOT_FEEDBACK_FAILED: { label: "toolError.SCREENSHOT_FEEDBACK_FAILED.label", message: "toolError.SCREENSHOT_FEEDBACK_FAILED.message" },
  SELECTOR_BOUNDS_FAILED: { label: "toolError.SELECTOR_BOUNDS_FAILED.label", message: "toolError.SELECTOR_BOUNDS_FAILED.message" },
  SEND_ALERT_FAILED: { label: "toolError.SEND_ALERT_FAILED.label" },
  SEND_ALERT_PERMISSION_DENIED: { label: "toolError.SEND_ALERT_PERMISSION_DENIED.label" },
  SEND_ALERT_UNAVAILABLE: { label: "toolError.SEND_ALERT_UNAVAILABLE.label" },
  SESSION_EXPORT_IMPORT_FAILED: { label: "toolError.SESSION_EXPORT_IMPORT_FAILED.label" },
  SESSION_EXPORT_SOURCE_NOT_ALLOWED: { label: "toolError.SESSION_EXPORT_SOURCE_NOT_ALLOWED.label" },
  SESSION_DELETED: { label: "toolError.SESSION_DELETED.label" },
  SESSION_NOT_FOUND: { label: "toolError.SESSION_NOT_FOUND.label", message: "toolError.SESSION_NOT_FOUND.message" },
  SESSION_RUNTIME_UNAVAILABLE: { label: "toolError.SESSION_RUNTIME_UNAVAILABLE.label", message: "toolError.SESSION_RUNTIME_UNAVAILABLE.message" },
  SESSION_TAB_FOREIGN: { label: "toolError.SESSION_TAB_FOREIGN.label" },
  SESSION_TAB_NOT_WEB: { label: "toolError.SESSION_TAB_NOT_WEB.label" },
  SESSION_TAB_TARGET_DENIED: { label: "toolError.SESSION_TAB_TARGET_DENIED.label" },
  SESSION_TAB_TARGET_REQUIRED: { label: "toolError.SESSION_TAB_TARGET_REQUIRED.label" },
  SESSION_TAB_UNAVAILABLE: { label: "toolError.SESSION_TAB_UNAVAILABLE.label" },
  SESSION_TAB_UNOWNED: { label: "toolError.SESSION_TAB_UNOWNED.label" },
  SESSION_TOOL_FORBIDDEN: { label: "toolError.SESSION_TOOL_FORBIDDEN.label", message: "toolError.SESSION_TOOL_FORBIDDEN.message" },
  SKILL_ALREADY_EXISTS: { label: "toolError.SKILL_ALREADY_EXISTS.label" },
  SKILL_BINARY_RESOURCE_TEXT_EDIT_UNSUPPORTED: { label: "toolError.SKILL_BINARY_RESOURCE_TEXT_EDIT_UNSUPPORTED.label" },
  SKILL_CREATE_REQUIRES_CONTENT: { label: "toolError.SKILL_CREATE_REQUIRES_CONTENT.label", message: "toolError.SKILL_CREATE_REQUIRES_CONTENT.message" },
  SKILL_DOCUMENT_BINARY_INVALID: { label: "toolError.SKILL_DOCUMENT_BINARY_INVALID.label" },
  SKILL_DOCUMENT_BINARY_MISSING: { label: "toolError.SKILL_DOCUMENT_BINARY_MISSING.label" },
  SKILL_DOCUMENT_FORMAT_UNSUPPORTED: { label: "toolError.SKILL_DOCUMENT_FORMAT_UNSUPPORTED.label" },
  SKILL_DOCUMENT_PARSE_FAILED: { label: "toolError.SKILL_DOCUMENT_PARSE_FAILED.label" },
  SKILL_DOCUMENT_RUNTIME_UNAVAILABLE: { label: "toolError.SKILL_DOCUMENT_RUNTIME_UNAVAILABLE.label" },
  SKILL_DOCUMENT_SESSION_REQUIRED: { label: "toolError.SKILL_DOCUMENT_SESSION_REQUIRED.label" },
  SKILL_DOCUMENT_TOO_LARGE: { label: "toolError.SKILL_DOCUMENT_TOO_LARGE.label" },
  SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE: { label: "toolError.SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE.label" },
  SKILL_REGISTRY_RUNTIME_UNAVAILABLE: { label: "toolError.SKILL_REGISTRY_RUNTIME_UNAVAILABLE.label" },
  SKILL_EDIT_ALREADY_APPLIED: { label: "toolError.SKILL_EDIT_ALREADY_APPLIED.label", message: "toolError.SKILL_EDIT_ALREADY_APPLIED.message" },
  SKILL_EDIT_EMPTY_OLD_TEXT: { label: "toolError.SKILL_EDIT_EMPTY_OLD_TEXT.label", message: "toolError.SKILL_EDIT_EMPTY_OLD_TEXT.message" },
  SKILL_EDIT_OLD_TEXT_NOT_FOUND: { label: "toolError.SKILL_EDIT_OLD_TEXT_NOT_FOUND.label", message: "toolError.SKILL_EDIT_OLD_TEXT_NOT_FOUND.message" },
  SKILL_EDIT_OLD_TEXT_NOT_UNIQUE: { label: "toolError.SKILL_EDIT_OLD_TEXT_NOT_UNIQUE.label", message: "toolError.SKILL_EDIT_OLD_TEXT_NOT_UNIQUE.message" },
  SKILL_EDIT_OVERLAP: { label: "toolError.SKILL_EDIT_OVERLAP.label", message: "toolError.SKILL_EDIT_OVERLAP.message" },
  SKILL_MCP_CONFIG_INVALID: { label: "toolError.SKILL_MCP_CONFIG_INVALID.label" },
  SKILL_MCP_VALIDATE_FAILED: { label: "toolError.SKILL_MCP_VALIDATE_FAILED.label" },
  SKILL_IMPORT_NAME_CONFLICT: { label: "toolError.SKILL_IMPORT_NAME_CONFLICT.label" },
  SKILL_NETWORK_BODY_INVALID: { label: "toolError.SKILL_NETWORK_BODY_INVALID.label" },
  SKILL_NETWORK_BODY_NOT_ALLOWED: { label: "toolError.SKILL_NETWORK_BODY_NOT_ALLOWED.label" },
  SKILL_NETWORK_CALLER_UNTRUSTED: { label: "toolError.SKILL_NETWORK_CALLER_UNTRUSTED.label" },
  SKILL_NETWORK_EXECUTION_EXPIRED: { label: "toolError.SKILL_NETWORK_EXECUTION_EXPIRED.label" },
  SKILL_NETWORK_EXECUTION_INVALID: { label: "toolError.SKILL_NETWORK_EXECUTION_INVALID.label" },
  SKILL_NETWORK_FETCH_FAILED: { label: "toolError.SKILL_NETWORK_FETCH_FAILED.label" },
  SKILL_NETWORK_HEADERS_INVALID: { label: "toolError.SKILL_NETWORK_HEADERS_INVALID.label" },
  SKILL_NETWORK_HEADER_FORBIDDEN: { label: "toolError.SKILL_NETWORK_HEADER_FORBIDDEN.label" },
  SKILL_NETWORK_MANAGED_HEADER_NOT_ALLOWED: { label: "toolError.SKILL_NETWORK_MANAGED_HEADER_NOT_ALLOWED.label" },
  SKILL_NETWORK_MANAGED_HEADER_UNAVAILABLE: { label: "toolError.SKILL_NETWORK_MANAGED_HEADER_UNAVAILABLE.label" },
  SKILL_NETWORK_METHOD_NOT_ALLOWED: { label: "toolError.SKILL_NETWORK_METHOD_NOT_ALLOWED.label" },
  SKILL_NETWORK_ORIGIN_NOT_ALLOWED: { label: "toolError.SKILL_NETWORK_ORIGIN_NOT_ALLOWED.label" },
  SKILL_NETWORK_REQUEST_TOO_LARGE: { label: "toolError.SKILL_NETWORK_REQUEST_TOO_LARGE.label" },
  SKILL_NETWORK_RESPONSE_TOO_LARGE: { label: "toolError.SKILL_NETWORK_RESPONSE_TOO_LARGE.label" },
  SKILL_NETWORK_RULE_CLEANUP_FAILED: { label: "toolError.SKILL_NETWORK_RULE_CLEANUP_FAILED.label" },
  SKILL_NETWORK_UNAVAILABLE: { label: "toolError.SKILL_NETWORK_UNAVAILABLE.label" },
  SKILL_NETWORK_URL_INVALID: { label: "toolError.SKILL_NETWORK_URL_INVALID.label" },
  SKILL_NETWORK_URL_TOO_LONG: { label: "toolError.SKILL_NETWORK_URL_TOO_LONG.label" },
  SKILL_NOT_FOUND: { label: "toolError.SKILL_NOT_FOUND.label" },
  SKILL_PLUGIN_JSON_INVALID: { label: "toolError.SKILL_PLUGIN_JSON_INVALID.label" },
  SKILL_PLUGIN_MANIFEST_INVALID: { label: "toolError.SKILL_PLUGIN_MANIFEST_INVALID.label", message: "toolError.SKILL_PLUGIN_MANIFEST_INVALID.message" },
  SKILL_READ_ONLY: { label: "toolError.SKILL_READ_ONLY.label" },
  SKILL_RESOURCE_NOT_FOUND: { label: "toolError.SKILL_RESOURCE_NOT_FOUND.label" },
  SKILL_SETTINGS_INVALID: { label: "toolError.SKILL_SETTINGS_INVALID.label" },
  SKILL_SETTINGS_NOT_FOUND: { label: "toolError.SKILL_SETTINGS_NOT_FOUND.label" },
  SKILL_SETTINGS_REQUIRED: { label: "toolError.SKILL_SETTINGS_REQUIRED.label" },
  SKILL_SETTINGS_UNAVAILABLE: { label: "toolError.SKILL_SETTINGS_UNAVAILABLE.label" },
  SKILL_SETTING_SECRET_REENTRY_REQUIRED: { label: "toolError.SKILL_SETTING_SECRET_REENTRY_REQUIRED.label" },
  SKILL_SETTING_UNKNOWN: { label: "toolError.SKILL_SETTING_UNKNOWN.label" },
  SKILL_SETTING_VALUE_INVALID: { label: "toolError.SKILL_SETTING_VALUE_INVALID.label" },
  BROWSER_WINDOW_TARGET_UNAVAILABLE: { label: "toolError.BROWSER_WINDOW_TARGET_UNAVAILABLE.label", message: "toolError.BROWSER_WINDOW_TARGET_UNAVAILABLE.message" },
  NO_NORMAL_BROWSER_WINDOW: { label: "toolError.NO_NORMAL_BROWSER_WINDOW.label", message: "toolError.NO_NORMAL_BROWSER_WINDOW.message" },
  GIT_PUBLISH_TARGET_UNAVAILABLE: { label: "toolError.GIT_PUBLISH_TARGET_UNAVAILABLE.label" },
  GIT_PUBLISH_RESOURCE_BINARY_INVALID: { label: "toolError.GIT_PUBLISH_RESOURCE_BINARY_INVALID.label" },
  INPUT_NOT_DELIVERED: { label: "toolError.INPUT_NOT_DELIVERED.label", message: "toolError.INPUT_NOT_DELIVERED.message" },
  STALE_ELEMENT_UID: { label: "toolError.STALE_ELEMENT_UID.label", message: "toolError.STALE_ELEMENT_UID.message" },
  STALE_ELEMENT_UID_PAGE_CHANGED: { label: "toolError.STALE_ELEMENT_UID_PAGE_CHANGED.label", message: "toolError.STALE_ELEMENT_UID_PAGE_CHANGED.message" },
  STALE_IMAGE_TARGET: { label: "toolError.STALE_IMAGE_TARGET.label", message: "toolError.STALE_IMAGE_TARGET.message" },
  UNSUPPORTED_SCREEN_ACTION: { label: "toolError.UNSUPPORTED_SCREEN_ACTION.label", message: "toolError.UNSUPPORTED_SCREEN_ACTION.message" },
  STALE_RUN: { label: "toolError.STALE_SESSION_LEASE.label" },
  STALE_SESSION_LEASE: { label: "toolError.STALE_SESSION_LEASE.label" },
  TAB_CAPTURE_AWAITING_USER_GRANT: { label: "toolError.TAB_CAPTURE_AWAITING_USER_GRANT.label" },
  TAB_CAPTURE_EMPTY_STREAM_ID: { label: "toolError.TAB_CAPTURE_EMPTY_STREAM_ID.label" },
  TAB_CAPTURE_GRANT_DENIED: { label: "toolError.TAB_CAPTURE_GRANT_DENIED.label" },
  TAB_CAPTURE_GRANT_EMPTY_STREAM_ID: { label: "toolError.TAB_CAPTURE_GRANT_EMPTY_STREAM_ID.label" },
  TAB_CAPTURE_STREAM_ID_FAILED: { label: "toolError.TAB_CAPTURE_STREAM_ID_FAILED.label" },
  TAB_LOAD_TIMEOUT: { label: "toolError.TAB_LOAD_TIMEOUT.label", message: "toolError.TAB_LOAD_TIMEOUT.message" },
  TOOL_ABORTED: { label: "toolError.TOOL_ABORTED.label", message: "toolError.TOOL_ABORTED.message" },
  TOOL_EXECUTION_FAILED: { label: "toolError.TOOL_EXECUTION_FAILED.label" },
  TOOL_FORBIDDEN_BY_RUN_PROFILE: { label: "toolError.TOOL_FORBIDDEN_BY_RUN_PROFILE.label" },
  TOOL_INTERRUPTED: { label: "toolError.TOOL_INTERRUPTED.label", message: "toolError.TOOL_INTERRUPTED.message" },
  TOOL_NOT_EXECUTED: { label: "toolError.TOOL_NOT_EXECUTED.label", message: "toolError.TOOL_NOT_EXECUTED.message" },
  TOOL_TIMEOUT: { label: "toolError.TOOL_TIMEOUT.label" },
  UNKNOWN_TOOL: { label: "toolError.UNKNOWN_TOOL.label" },
  UNKNOWN_PLUGIN_TOOL: { label: "toolError.UNKNOWN_PLUGIN_TOOL.label" },
  UNSUPPORTED_ELEMENT_ACTION: { label: "toolError.UNSUPPORTED_ELEMENT_ACTION.label" },
  UNSUPPORTED_IMAGE_URL_SCHEME: { label: "toolError.UNSUPPORTED_IMAGE_URL_SCHEME.label", message: "toolError.UNSUPPORTED_IMAGE_URL_SCHEME.message" },
  USER_CANCELLED_WAIT: { label: "toolError.USER_CANCELLED_WAIT.label", message: "toolError.USER_CANCELLED_WAIT.message" },
  USER_WAIT_RUNTIME_UNAVAILABLE: { label: "toolError.USER_WAIT_RUNTIME_UNAVAILABLE.label", message: "toolError.USER_WAIT_RUNTIME_UNAVAILABLE.message" },
  WAIT_SUPERSEDED: { label: "toolError.WAIT_SUPERSEDED.label", message: "toolError.WAIT_SUPERSEDED.message" },
  WAIT_UNTIL_TOO_FAR: { label: "toolError.WAIT_UNTIL_TOO_FAR.label" },
});

const DIAGNOSTIC_CATEGORY_LABELS: Readonly<Record<string, BackendMessageKey>> = Object.freeze({
  page_context: "toolFailure.pageContext",
  page_lifecycle: "toolFailure.pageLifecycle",
  timeout: "toolFailure.timeout",
  tool_bridge: "toolFailure.toolBridge",
  selector: "toolFailure.selector",
  permissions: "toolFailure.permissions",
  network: "toolFailure.network",
  script: "toolFailure.script",
  unknown: "toolFailure.unknown",
});

export function localizeToolFailureCode(code: unknown = "") {
  const value = String(code || "").trim().toUpperCase();
  if (!value) return "";
  if (ERROR_CATALOG[value]) return t(ERROR_CATALOG[value].label);
  if (!UPPER_ERROR_CODE_RE.test(value)) return "";
  return t("toolFailure.toolFailed");
}

export function hasLocalizedToolFailureCode(code: unknown = "") {
  return Boolean(ERROR_CATALOG[String(code || "").trim().toUpperCase()]);
}

export function localizeToolFailureError(value: unknown, context: FailureContext = {}) {
  if (!value || typeof value !== "object") {
    return new Error(localizeToolFailureText(String(value || t("toolFailure.toolFailed")), context));
  }
  const err = value as Record<string, unknown>;
  const original = String(err.message || err.error || "");
  const originalCode = String(err.code || context.code || "").trim();
  const localized = localizeToolFailureText(original, {
    ...context,
    code: originalCode,
    details: err.details || context.details || {},
  });
  if (localized && localized !== original) {
    try {
      err.message = localized;
      if (err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
        err.details = { ...err.details, originalMessage: objectValue(err.details).originalMessage || original };
      }
    } catch (_e) {}
  }
  const codeLabel = localizeToolFailureCode(originalCode);
  if (codeLabel) {
    try {
      err.codeLabel = codeLabel;
      if (err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
        err.details = { ...err.details, originalCode: objectValue(err.details).originalCode || originalCode };
      }
    } catch (_e) {}
  }
  return err;
}

export function localizeToolFailurePayload(payload: unknown, context: FailureContext = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const hasFailureSignal = isFailurePayload(payload as Record<string, unknown>, context);
  if (!hasFailureSignal) return payload;
  const out = { ...payload } as Record<string, unknown>;
  const details = out.details && typeof out.details === "object" && !Array.isArray(out.details) ? objectValue(out.details) : {};
  const code = String(out.code || context.code || "").trim();
  const baseContext = {
    ...context,
    code,
    details,
  };
  const codeLabel = localizeToolFailureCode(code);
  if (codeLabel) {
    out.codeLabel = codeLabel;
    out.details = { ...details, originalCode: details.originalCode || code };
  }

  if (typeof out.error === "string" && out.error.trim()) {
    const original = out.error;
    out.error = localizeToolFailureText(original, baseContext);
    if (out.error !== original) {
      const nextDetails = out.details && typeof out.details === "object" && !Array.isArray(out.details) ? objectValue(out.details) : details;
      out.details = { ...nextDetails, originalError: nextDetails.originalError || original };
    }
  }
  if (typeof out.message === "string" && out.message.trim() && (out.ok === false || out.error)) {
    const original = out.message;
    out.message = localizeToolFailureText(original, baseContext);
    const nextDetails = out.details && typeof out.details === "object" && !Array.isArray(out.details) ? objectValue(out.details) : details;
    if (out.message !== original) out.details = { ...nextDetails, originalMessage: nextDetails.originalMessage || original };
  }
  if (!out.error && !out.message && codeLabel) out.error = codeLabel;
  if (out.diagnostic && typeof out.diagnostic === "object" && !Array.isArray(out.diagnostic)) {
    out.diagnostic = localizeToolDiagnostic(out.diagnostic);
  }
  return out;
}

export function localizeToolFailureText(message: unknown = "", context: FailureContext = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  const details = objectValue(context.details);
  const code = String(context.code || "").trim();
  const toolName = String(context.toolName || details.toolName || details.tool || details.name || "").trim();
  const preferPattern = [
    "CDP_COMMAND_FAILED",
    "CONTENT_SCRIPT_MESSAGE_FAILED",
    "RUN_SCRIPT_TOOL_CALL_FAILED",
    "SCRIPT_EVALUATION_FAILED",
  ].includes(code);
  const patternText = localizeByPattern(text, { ...details, toolName });
  if (preferPattern && patternText) return patternText;
  const codeText = localizeByCode(code, { ...details, toolName, text });
  if (codeText) return codeText;
  if (patternText) return patternText;
  if (!text) return t("toolFailure.toolFailedSentence");
  if (getLanguage() === "zh-CN" && CJK_RE.test(text)) return localizeMixedChineseText(text);
  if (ERROR_CATALOG[code]) {
    return getLanguage() === "en" && !CJK_RE.test(text) ? text : localizeToolFailureCode(code);
  }
  return t("toolFailure.toolFailedSentence");
}

export function localizeToolDiagnostic(diagnostic: unknown = {}) {
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return diagnostic;
  const out = { ...diagnostic } as Record<string, unknown>;
  const category = String(out.originalCategory || out.category || "").trim();
  if (category && DIAGNOSTIC_CATEGORY_LABELS[category]) {
    out.category = t(DIAGNOSTIC_CATEGORY_LABELS[category]);
    out.originalCategory = out.originalCategory || category;
  }
  return out;
}

function isFailurePayload(payload: Record<string, unknown>, context: FailureContext = {}) {
  if (payload.ok === false || payload.isError === true || payload.error != null) return true;
  if (context.isError === true) return true;
  return hasLocalizedToolFailureCode(payload.code || context.code || "");
}

function localizeByCode(code: string, details: Record<string, unknown> = {}) {
  const message = ERROR_CATALOG[code]?.message;
  if (message) return t(message);
  const tool = details.toolName || details.tool || details.name || t("toolFailure.thisTool");
  const action = details.action || "";
  const tabId = details.tabId || details.refTabId || "";
  const missing = Array.isArray(details.missing) ? details.missing.join(", ") : "";
  switch (code) {
    case "UNKNOWN_TOOL":
      return t("toolFailure.unknownTool", { tool: String(tool) });
    case "UNKNOWN_PLUGIN_TOOL":
      return t("toolFailure.unknownSkillTool", { tool: String(tool) });
    case "TOOL_FORBIDDEN_BY_RUN_PROFILE":
      return t("toolFailure.toolForbidden", { tool: String(tool) });
    case "TOOL_EXECUTION_FAILED":
      return t("toolFailure.toolCallFailed", { tool: String(tool) });
    case "INVALID_ARGUMENTS": {
      if (!details.path || details.path === "$") return t("toolFailure.objectRequired", { tool: String(tool) });
      const field = String(details.path).replace(/^\$\./, "");
      if (Array.isArray(details.allowedValues)) return t("toolFailure.allowedValues", { tool: String(tool), field, values: details.allowedValues.map(String).join(getLanguage() === "zh-CN" ? "、" : ", ") });
      const labels: Record<string, string> = { string: t("toolFailure.textType"), number: t("toolFailure.numberType"), integer: t("toolFailure.integerType"), boolean: t("toolFailure.booleanType"), object: t("toolFailure.objectType"), array: t("toolFailure.arrayType"), null: t("toolFailure.nullType") };
      const types = Array.isArray(details.expectedType) ? details.expectedType : [details.expectedType];
      const expected = types.map(type => labels[String(type)] || String(type || t("toolFailure.validValue"))).join(t("toolFailure.or"));
      return t("toolFailure.expectedType", { tool: String(tool), field, expected });
    }
    case "INVALID_LONG_PRESS_DURATION":
      return t("toolFailure.longPress", { min: String(details.min || 300), max: String(details.max || 5000) });
    case "INVALID_SCROLL_REPEAT":
      return t("toolFailure.scrollRepeat", { min: String(details.min || 1), max: String(details.max || 20) });
    case "INVALID_TIMEOUT":
      return t("toolFailure.timeoutArgument", { tool: String(tool) });
    case "MISSING_REQUIRED_ARGUMENTS":
      return t("toolFailure.requiredArguments", { tool: String(tool), suffix: detailSuffix(missing) });
    case "NOT_WEB_TAB":
      return t("toolFailure.notWebTab", { tab: tabId ? t("toolFailure.tab", { id: String(tabId) }) : t("toolFailure.targetTab") });
    case "SECURITY_GUARDRAIL_BLOCKED":
      return securityGuardrailMessage(details);
    case "TOOL_TIMEOUT":
      return t("toolFailure.toolTimeout", { tool: String(tool) });
    case "UNSUPPORTED_ELEMENT_ACTION":
      return t("toolFailure.elementAction", { action: String(action || t("toolFailure.unknownAction")) });
    case "MISSING_SESSION_ID":
      return t("toolFailure.sessionRequired", { tool: String(tool) });
    case "MISSING_AUTOMATION_ID":
      return t("toolFailure.automationRequired", { tool: String(tool) });
    case "INVALID_SESSION_ACTION":
      return t("toolFailure.sessionAction", { tool: String(tool), action: String(action || t("toolFailure.unknownAction")) });
    case "INVALID_DATA_ACTION":
      return t("toolFailure.dataAction", { action: String(action || t("toolFailure.unknownAction")) });
    case "INVALID_BOOKMARK_ACTION":
      return t("toolFailure.bookmarkAction", { action: String(action || t("toolFailure.unknownAction")) });
    case "INVALID_HISTORY_ACTION":
      return t("toolFailure.historyAction", { action: String(action || t("toolFailure.unknownAction")) });
    case "IMAGE_SELECTION_LIMIT_EXCEEDED":
      return t("toolFailure.imageLimit", { maximum: Number(details.maximum) || 200 });
    case "IMAGE_COLLECTION_ALL_FAILED":
      return t("toolFailure.allImagesFailed", { failed: Number(details.failed) || t("toolFailure.all") });
    case "DOCUMENT_BLOCK_SCHEMA_INVALID":
      return t("toolFailure.blocksInvalid", { count: String(details.issueCount || "") });
    case "DOCUMENT_SHEET_SCHEMA_INVALID":
      return t("toolFailure.sheetsInvalid", { count: String(details.issueCount || "") });
    case "PLUGIN_HOST_ACTION_UNAVAILABLE":
      return t("toolFailure.skillAction", { suffix: detailSuffix([details.skillName, details.localName].filter(Boolean).join("/")) });
    case "PLUGIN_HOST_SCRIPT_FAILED":
      return t("toolFailure.skillScriptFailed", { suffix: detailSuffix([details.skillName, details.script].filter(Boolean).join("/")) });
    case "PLUGIN_HOST_SCRIPT_MISSING":
    case "PLUGIN_TOOL_SCRIPT_MISSING":
      return t("toolFailure.skillScriptMissing", { suffix: detailSuffix([details.skillName, details.script].filter(Boolean).join("/")) });
    case "PLUGIN_NOT_FOUND":
      return t("toolFailure.pluginMissing", { suffix: detailSuffix(details.pluginId) });
    case "SKILL_NOT_FOUND":
      return t("toolFailure.skillMissing", { suffix: detailSuffix(details.name) });
    case "SKILL_RESOURCE_NOT_FOUND":
      return t("toolFailure.skillResourceMissing", { suffix: detailSuffix(details.path) });
    case "SKILL_ALREADY_EXISTS":
      return t("toolFailure.skillExists", { suffix: details.displayName || details.name ? detailSuffix(details.displayName || details.name) : "" });
    case "SKILL_PLUGIN_JSON_INVALID":
      return t("toolFailure.skillInvalidJson", { location: details.line ? t("toolFailure.jsonLine", { line: String(details.line), column: details.column ? t("toolFailure.jsonColumn", { column: String(details.column) }) : "" }) : "" });
    case "WAIT_UNTIL_TOO_FAR":
      return t("toolFailure.maxWait", { seconds: Number(details.maxWaitSeconds) || 7200 });
    default:
      return "";
  }
}

function localizeByPattern(text: string, _details: Record<string, unknown> = {}) {
  if (!text) return "";
  let match = text.match(/^Unknown tool: (.+)$/i);
  if (match) return t("toolFailure.unknownTool", { tool: match[1] });
  if (/No active tab is available/i.test(text)) return t("toolError.NO_ACTIVE_TAB.message");
  if (/Active tab is not a web page/i.test(text)) return t("toolError.NO_ACTIVE_WEB_TAB.message");
  match = text.match(/^Invalid arguments for ([^:]+): expected an object/i);
  if (match) return t("toolFailure.objectRequired", { tool: match[1] });
  match = text.match(/^Invalid arguments for ([^:]+): missing required field\(s\): (.+)$/i);
  if (match) return t("toolFailure.missingFields", { tool: match[1], fields: match[2] });
  match = text.match(/^Operation aborted(?: before| while)? (.+)$/i);
  if (match) return t("toolError.OPERATION_ABORTED.message");
  match = text.match(/(.+) timed out after (\d+)ms/i);
  if (match) return t("toolFailure.toolTimeoutAfter", { tool: match[1], duration: match[2] });
  if (/run has been stopped/i.test(text)) return t("toolError.RUN_STOPPED.message");
  if (/requires sessionIds/i.test(text)) return t("toolFailure.waitSessionsRequired");
  if (/Cannot wait for the session currently executing this tool/i.test(text)) return t("toolFailure.noWaitCurrentSession");
  if (/Some sessions do not exist/i.test(text)) return t("toolFailure.someSessionsMissing");
  if (/Cannot delete the session currently executing this tool/i.test(text)) return t("toolError.CANNOT_DELETE_CALLER_SESSION.message");
  if (/Session runtime is not available/i.test(text)) return t("toolError.SESSION_RUNTIME_UNAVAILABLE.message");
  if (/Automation runtime is not available/i.test(text)) return t("toolError.AUTOMATION_RUNTIME_UNAVAILABLE.message");
  match = text.match(/^Unsupported ([\w_]+) action: (.+)$/i);
  if (match) return t("toolFailure.unsupportedAction", { tool: match[1], action: match[2] });
  if (/Element reference requires target/i.test(text) || /Element reference requires either uid or selector/i.test(text)) return t("toolError.MISSING_ELEMENT_REFERENCE.message");
  if (/Invalid element target/i.test(text)) return t("toolError.INVALID_ELEMENT_TARGET.message");
  if (/Element (?:uid|target) is stale or unknown/i.test(text)) return t("toolError.STALE_ELEMENT_UID.message");
  if (/Element (?:uid|target) belongs to another session/i.test(text)) return t("toolFailure.noElementSession");
  if (/Element (?:uid|target) belongs to a previous page state/i.test(text)) return t("toolError.STALE_ELEMENT_UID_PAGE_CHANGED.message");
  if (/Element (?:uid|target) belongs to tab/i.test(text)) return t("toolError.ELEMENT_UID_TAB_MISMATCH.message");
  if (/Element has no clickable point/i.test(text)) return t("toolError.NO_CLICKABLE_POINT.message");
  if (/key is required for press action/i.test(text)) return t("toolError.MISSING_KEY.message");
  if (/Failed to fetch image URL/i.test(text)) return t("toolError.IMAGE_URL_FETCH_FAILED.message");
  match = text.match(/^Image URL returned HTTP (\d+)/i);
  if (match) return t("toolFailure.imageHttp", { status: match[1] });
  if (/Image URL is too large/i.test(text)) return t("toolError.IMAGE_URL_TOO_LARGE.message");
  if (/URL did not return an image/i.test(text)) return t("toolError.IMAGE_URL_NOT_IMAGE.message");
  if (/CDP failed: .*scripting fallback failed:/i.test(text)) return t("toolError.SCRIPT_EXECUTION_UNAVAILABLE.message");
  if (/Script evaluation failed/i.test(text)) return t("toolError.SCRIPT_EVALUATION_FAILED.message");
  if (/Cannot read propert(?:y|ies) of (null|undefined)/i.test(text)) return t("toolFailure.nullProperty");
  if (/is not defined/i.test(text)) return t("toolFailure.undefinedVariable");
  if (/Unexpected token|Unexpected identifier|SyntaxError/i.test(text)) return t("toolFailure.scriptSyntax");
  if (/Failed to fetch/i.test(text)) return t("toolFailure.networkFailed");
  if (/Invalid regular expression/i.test(text)) return t("toolError.INVALID_REGEX.message");
  if (/Network request not found/i.test(text)) return t("toolError.NETWORK_REQUEST_NOT_FOUND.message");
  if (/run_script blocked .* on its own tab/i.test(text)) return t("toolError.RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED.message");
  if (/run_script tool bridge requires toolName|tools call requires a tool name/i.test(text)) return t("toolError.MISSING_TOOL_NAME.message");
  if (/nested tool call depth exceeded/i.test(text)) return t("toolError.RUN_SCRIPT_TOOL_DEPTH_EXCEEDED.message");
  if (/bridge timed out/i.test(text)) return t("toolFailure.bridgeTimeout");
  if (/empty bridge response|returned empty bridge response/i.test(text)) return t("toolFailure.bridgeEmpty");
  if (/tool bridge failed|bridge failed/i.test(text)) return t("toolError.RUN_SCRIPT_TOOL_CALL_FAILED.message");
  match = text.match(/^Skill "(.+)" not found$/i);
  if (match) return t("toolFailure.skillMissingNamed", { name: match[1] });
  if (/Creating a new skill requires description and content/i.test(text)) return t("toolError.SKILL_CREATE_REQUIRES_CONTENT.message");
  if (/oldText must not be empty/i.test(text)) return t("toolError.SKILL_EDIT_EMPTY_OLD_TEXT.message");
  if (/oldText.*not found|could not find oldText/i.test(text)) return t("toolError.SKILL_EDIT_OLD_TEXT_NOT_FOUND.message");
  if (/oldText.*not unique|multiple matches/i.test(text)) return t("toolError.SKILL_EDIT_OLD_TEXT_NOT_UNIQUE.message");
  if (/record not found/i.test(text)) return t("toolFailure.recordMissing");
  if (/Failed to open IndexedDB/i.test(text)) return t("toolFailure.indexedDbFailed");
  if (/not found/i.test(text)) return t("toolFailure.resourceMissing");
  if (/not available|unavailable/i.test(text)) return t("toolFailure.featureUnavailable");
  if (/timed out|timeout/i.test(text)) return t("toolFailure.operationTimeout");
  if (/failed/i.test(text)) return t("toolFailure.operationFailed");
  if (/requires/i.test(text)) return t("toolFailure.argumentsMissing");
  if (/cannot/i.test(text)) return t("toolFailure.operationCannotComplete");
  return "";
}

function securityGuardrailMessage(details: Record<string, unknown> = {}) {
  const pattern = details.blockedPattern || details.pattern;
  const domain = details.blockedDomain || details.domain;
  const host = details.host;
  if (pattern) return t("toolFailure.blockedPattern", { pattern: String(pattern) });
  if (domain) return t("toolFailure.blockedDomain", { domain: String(domain) });
  if (host) return t("toolFailure.blockedHost", { host: String(host) });
  return t("toolFailure.securityBlocked");
}

function localizeMixedChineseText(text: string) {
  return String(text || "")
    .replace(/\bAgent\b/g, "智能体")
    .replace(/\bData tab\b/g, "Data 页面")
    .replace(/安全护栏/g, "安全策略");
}

function detailSuffix(value: unknown) {
  return value ? (getLanguage() === "zh-CN" ? `：${value}` : `: ${value}`) : (getLanguage() === "zh-CN" ? "。" : ".");
}
