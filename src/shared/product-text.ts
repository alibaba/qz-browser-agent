/** Chrome sentences stay in the Chrome package. A Firefox extension page takes the second sentence. */
export function productText(chromeText: string, firefoxText: string): string {
  return firefoxExtension() ? firefoxText : chromeText;
}

export function firefoxExtension(): boolean {
  try {
    const runtime = (globalThis as { chrome?: { runtime?: { getURL?(path: string): string } } }).chrome?.runtime;
    return runtime?.getURL?.("")?.startsWith("moz-extension:") === true;
  } catch {
    return false;
  }
}
