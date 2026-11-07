/** Content replies cross as unknown data; these guards validate shape, not Session/tab authority. */
export interface PageAction {
  uid?: string; target?: string; _elementRef?: string; i?: number; selector?: string; role?: string; type?: string; name?: string;
  text?: string; textLength?: number; value?: string; placeholder?: string; href?: string; disabled?: boolean;
  editable?: boolean; checked?: boolean; accept?: string; multiple?: boolean; selectedFileCount?: number;
  inViewport?: boolean; rect?: object;
}
export interface PageCanvas {
  uid?: string; target?: string; selector?: string; _elementRef?: string;
  name?: string; rect?: { x?: number; y?: number; w?: number; h?: number }; inViewport?: boolean;
  bitmapSize?: { width?: number; height?: number };
}
export interface PageOverview {
  title?: string; url?: string; viewport?: object; actions?: PageAction[]; headings?: { level?: number | null; text?: string; selector?: string }[];
  canvases?: PageCanvas[]; error?: string; code?: string;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, names: readonly string[], type: string) => names.every(name => value[name] === undefined || typeof value[name] === type);
function action(value: unknown): value is PageAction {
  return object(value)
    && fields(value, ["uid", "target", "selector", "role", "type", "name", "text", "value", "placeholder", "href", "accept"], "string")
    && fields(value, ["i", "textLength", "selectedFileCount"], "number")
    && fields(value, ["disabled", "editable", "checked", "multiple", "inViewport"], "boolean")
    && (value.rect === undefined || object(value.rect));
}
export function isPageOverview(value: unknown): value is PageOverview {
  if (!object(value) || !fields(value, ["title", "url", "error", "code"], "string")) return false;
  if (value.viewport !== undefined && !object(value.viewport)) return false;
  if (value.actions !== undefined && (!Array.isArray(value.actions) || !value.actions.every(action))) return false;
  if (value.headings !== undefined && (!Array.isArray(value.headings) || !value.headings.every(item => object(item)
    && (item.level === null || fields(item, ["level"], "number")) && fields(item, ["text", "selector"], "string")))) return false;
  return value.canvases === undefined || (Array.isArray(value.canvases) && value.canvases.every(item => object(item)
    && fields(item, ["name"], "string") && fields(item, ["inViewport"], "boolean")
    && (item.rect === undefined || (object(item.rect) && fields(item.rect, ["x", "y", "w", "h"], "number")))
    && (item.bitmapSize === undefined || (object(item.bitmapSize) && fields(item.bitmapSize, ["width", "height"], "number")))));
}

export interface PagePoint { x: number; y: number }
export interface ElementReply extends Record<string, unknown> {
  error?: string; code?: string; selector?: string; href?: string; resolvedSelector?: string;
  clicked?: boolean; navigated?: boolean; visible?: boolean; disabled?: boolean; clickablePoint?: PagePoint | null;
  state?: { inViewport?: boolean; clickablePointInViewport?: boolean; obscuredAtCenter?: boolean };
}
export function isElementReply(value: unknown): value is ElementReply {
  return object(value)
    && fields(value, ["error", "code", "selector", "href", "resolvedSelector"], "string")
    && fields(value, ["clicked", "navigated", "visible", "disabled"], "boolean")
    && (value.clickablePoint == null || (object(value.clickablePoint)
      && typeof value.clickablePoint.x === "number" && Number.isFinite(value.clickablePoint.x)
      && typeof value.clickablePoint.y === "number" && Number.isFinite(value.clickablePoint.y)))
    && (value.state === undefined || (object(value.state)
      && fields(value.state, ["inViewport", "clickablePointInViewport", "obscuredAtCenter"], "boolean")));
}
