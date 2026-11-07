export interface Rect { x: number; y: number; width: number; height: number }

/** Canonical page geometry, including legacy Content w/h boxes. */
export function toRect(input: unknown, fallback = 0): Rect {
  const box = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return { x: number(box.x), y: number(box.y), width: number(box.width ?? box.w), height: number(box.height ?? box.h) };
}

/** Public page-element observation. The only element identity is target. */
export interface ElementObservation {
  target?: `uid:${string}` | `css:${string}`;
  tag?: string; role?: string; type?: string; name?: string; text?: string; value?: unknown;
  placeholder?: string; href?: string; visible?: boolean; disabled?: boolean; editable?: boolean;
  checked?: boolean; selected?: boolean; readOnly?: boolean; focused?: boolean; actionable?: boolean;
  inViewport?: boolean; clickablePointInViewport?: boolean; obscuredAtCenter?: boolean;
  rect?: Rect;
  clickablePoint?: { x: number; y: number } | null;
  attrs?: Record<string, string>; state?: Record<string, unknown>;
  form?: ElementObservation | null; parent?: ElementObservation | null; nearbyText?: string;
  accept?: string; multiple?: boolean; selectedFileCount?: number;
  line?: number; lineRange?: number[]; index?: number; matched?: number;
  match?: string; matchKind?: string; score?: number;
  action?: string; method?: string;
}

export interface ImageObservation extends ElementObservation {
  rank?: number; alt?: string; title?: string; src?: string; currentSrc?: string;
  sourceKind?: string; sourceSummary?: string; loading?: string; complete?: boolean;
  naturalWidth?: number; naturalHeight?: number; hasSrcset?: boolean;
  context?: Record<string, string>;
}

export interface CanvasObservation extends ElementObservation {
  bitmapSize?: { width: number; height: number };
}

/** Construct an observation from business data and a handle supplied by the binding owner.
 * The source may be a private Content reply. No locator, token or node identity is copied.
 * Attribute values and other page-authored data remain intact.
 */
export function createElementObservation(source: Omit<Partial<ElementObservation>, 'rect'> & { rect?: unknown }, target?: string): ElementObservation {
  const result: ElementObservation = {};
  if (target && /^(?:uid|css):.+/.test(target)) result.target = target as ElementObservation['target'];
  const business = [
    'tag', 'role', 'type', 'name', 'text', 'value', 'placeholder', 'href', 'visible', 'disabled', 'editable',
    'checked', 'selected', 'readOnly', 'focused', 'actionable', 'inViewport', 'clickablePointInViewport',
    'obscuredAtCenter', 'clickablePoint', 'attrs', 'state', 'nearbyText', 'accept', 'multiple',
    'selectedFileCount', 'line', 'lineRange', 'index', 'matched', 'match', 'matchKind', 'score', 'action', 'method',
  ] as const satisfies readonly (keyof ElementObservation)[];
  for (const key of business) if (source[key] !== undefined) Object.assign(result, { [key]: source[key] });
  if (source.rect && typeof source.rect === 'object') result.rect = toRect(source.rect);
  return result;
}
