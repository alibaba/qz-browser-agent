/** Public page identity. active describes user visibility, not an implicit execution target. */
export interface PageObservation {
  tabRef: string | number;
  title: string;
  url: string;
  active: boolean;
}

const createdPages = new WeakMap<object, number>();
/** Native creation receipts keep browser identity out of the serialized observation. */
export function bindCreatedTabResult<T extends object>(result: T, id: number): T {
  createdPages.set(result, id);
  return result;
}
export function createdTabResultId(result: unknown): number | undefined {
  return result && typeof result === 'object' ? createdPages.get(result) : undefined;
}
export function copyCreatedTabResult<T>(source: unknown, target: T): T {
  const id = createdTabResultId(source);
  if (id && target && typeof target === 'object') createdPages.set(target, id);
  return target;
}
