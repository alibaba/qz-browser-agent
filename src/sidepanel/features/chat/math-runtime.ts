interface MathJaxRuntime {
  startup?: { promise?: Promise<unknown> };
  typesetPromise?(targets: Element[]): Promise<unknown>;
  typesetClear?(targets: Element[]): void;
  tex2svgPromise?(tex: string, options?: { display?: boolean }): Promise<Element>;
  texReset?(): void;
  svgStylesheet?(): HTMLStyleElement;
}

declare global { interface Window { MathJax?: MathJaxRuntime } }

type ReadyMathJax = MathJaxRuntime & Required<Pick<MathJaxRuntime, "typesetPromise">>;
let loading: Promise<ReadyMathJax> | undefined;
let typesetting: Promise<unknown> = Promise.resolve();

/** MathJax 3 shares one mutable document; concurrent renders can replace each other's targets. */
export function withMathRuntime<T>(render: (runtime: ReadyMathJax) => Promise<T>): Promise<T> {
  const next = typesetting.then(async () => render(await loadMathRuntime()));
  typesetting = next.catch(() => {});
  return next;
}

/** One SVG element with its glyph paths, so an exported document does not need the extension or a CDN. */
export function renderMathSvg(tex: string, display: boolean): Promise<string> {
  return withMathRuntime(async runtime => {
    if (!runtime.tex2svgPromise) throw new Error("MathJax SVG output is unavailable");
    const node = await runtime.tex2svgPromise(tex, { display });
    const svg = node.localName === "svg" ? node : node.querySelector("svg");
    if (!svg) throw new Error("MathJax did not return an SVG");
    return svg.outerHTML;
  });
}

/** Rules for error boxes, table lines, and glyph strokes. Exported SVGs are not inside mjx-container. */
export function mathExportStylesheet(): Promise<string> {
  return withMathRuntime(async runtime => adaptMathSvgStylesheet(runtime.svgStylesheet?.().textContent || ""));
}

/** Point MathJax's container rules at the formula element that wraps an exported SVG. */
export function adaptMathSvgStylesheet(css: string): string {
  return String(css || "")
    .replaceAll('mjx-container[jax="SVG"]', ".math-formula")
    .replaceAll("mjx-container[jax='SVG']", ".math-formula")
    .replace(/<\/style/giu, "<\\/style");
}

/** One local runtime per panel; a failed load must not poison later formula requests. */
function loadMathRuntime(): Promise<ReadyMathJax> {
  if (loading) return loading;
  let script: HTMLScriptElement | undefined;
  const previous = window.MathJax;
  const configuration = previous?.typesetPromise ? previous : structuredClone(previous);
  loading = (async () => {
    if (!window.MathJax?.typesetPromise) {
      await new Promise<void>((resolve, reject) => {
        script = document.createElement("script");
        script.id = "MathJax-script";
        script.src = globalThis.chrome?.runtime?.getURL("vendor/mathjax/startup.js")
          || new URL("../vendor/mathjax/startup.js", document.baseURI).href;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("MathJax could not be loaded"));
        document.head.append(script);
      });
    }
    const runtime = window.MathJax;
    await runtime?.startup?.promise;
    if (!runtime?.typesetPromise) throw new Error("MathJax did not initialize");
    return runtime as ReadyMathJax;
  })().catch(error => {
    script?.remove();
    window.MathJax = configuration;
    loading = undefined;
    throw error;
  });
  return loading;
}
