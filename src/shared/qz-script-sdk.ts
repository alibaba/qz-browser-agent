import { normalizeElementLocator, validateElementLocator, type ElementLocator } from "./contracts/element-locator.js";
import type { ElementObservation } from "./contracts/element-observation.js";

type Arguments = Record<string, unknown>;
type TabRef = string | number;
type PageFunction = string | ((...args: never[]) => unknown);
type CallTool = (name: string, args?: Arguments) => Promise<unknown>;
/** expect waits for the navigation or popup the action causes; tabAlias names that popup. */
type ActionOptions = { expect?: "navigation" | "popup"; timeout?: number; tabAlias?: string; submit?: boolean };
/**
 * page.find(query): role, name, text, exact, and within match as in page.locator(query);
 * pattern (string or RegExp) is the regex alternative to name/text.
 */
type FindQuery = Arguments & Pick<ElementLocator, "role" | "name" | "text" | "exact" | "within"> & {
  pattern?: string | RegExp; flags?: string; limit?: number; includeHidden?: boolean; waitForMatch?: boolean; timeout?: number;
};

/** Stateless script bindings. Every operation uses the host's normal tool execution path. */
export function createQzSdk(callTool: CallTool) {
  const locators = new WeakMap<object, { tabRef: TabRef; query: ElementLocator }>();
  const invalid = (message: string): never => {
    throw Object.assign(new TypeError(message), { code: "INVALID_ARGUMENTS" });
  };
  function options(value: Arguments = {}, reserved: readonly string[] = []): Arguments {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Pass an options object.");
    for (const key of reserved) {
      if (Object.hasOwn(value, key)) return invalid(`The bound SDK operation does not accept ${key}.`);
    }
    return { ...value };
  }
  function serializePattern(args: Arguments, key: "pattern" | "urlPattern"): Arguments {
    const pattern = args[key];
    if (!(pattern instanceof RegExp)) return args;
    if (Object.hasOwn(args, "flags")) return invalid("Set flags on the RegExp and omit options.flags.");
    return { ...args, [key]: pattern.source, flags: pattern.flags };
  }
  function tab(input: TabRef | { tabRef: TabRef }) {
    const reference: unknown = input && typeof input === "object" && !Array.isArray(input) ? input.tabRef : input;
    if (!(typeof reference === "string" && reference.trim() || typeof reference === "number" && Number.isInteger(reference) && reference > 0)) {
      return invalid("Pass a tabRef, its alias, or a returned Tab with tabRef.");
    }
    const tabRef = reference;
    const call = (name: string, args: Arguments = {}) => callTool(name, {
      ...options(args, ["tabRef", "tabId"]), tabRef,
    });
    function locator(input: string | (ElementLocator & { css?: string })) {
      const query: ElementLocator & { css?: string } = typeof input === "string" ? { target: input } : normalizeElementLocator({ ...input });
      if (Object.hasOwn(query, "css")) {
        if (Object.hasOwn(query, "target")) return invalid("Pass locator css or target, not both.");
        if (typeof query.css !== "string" || !query.css.trim()) return invalid("Locator css must be a non-empty string.");
        query.target = `css:${query.css}`;
        delete query.css;
      }
      try { validateElementLocator(query); }
      catch (error) {
        throw Object.assign(new TypeError(error instanceof Error ? error.message : String(error)), error, { code: "INVALID_ARGUMENTS" });
      }
      Object.freeze(query);
      const bindingKeys = ["target", "css", "selector", "locator", "index", "nth"];
      const boundCall = (name: string, args: Arguments = {}) => call(name, {
        ...options(args, bindingKeys), locator: { ...query },
      });
      function action(name: string, params: Arguments = {}, inputOptions: ActionOptions = {}) {
        // Hidden compatibility: waitFor and waitOptions are the retired spelling of expect.
        const { waitFor, waitOptions, ...given } = options(inputOptions);
        if (waitOptions !== undefined && waitFor === undefined) return invalid(`${name} does not accept waitOptions. Options: expect, timeout.`);
        const legacyWait = waitOptions === undefined ? {} : options(waitOptions as Arguments);
        const { expect = waitFor, timeout, tabAlias, ...rest } = { ...legacyWait, ...given };
        if (expect !== undefined && expect !== "navigation" && expect !== "popup") return invalid("Action expect must be navigation or popup.");
        const allowed = ["expect", "timeout", ...(name === "fill" ? ["submit"] : []), ...(expect === "popup" ? ["tabAlias"] : [])];
        const unknown = [...Object.keys(rest).filter(key => !allowed.includes(key)), ...(tabAlias !== undefined && expect !== "popup" ? ["tabAlias"] : [])];
        if (unknown.length) return invalid(`${name} does not accept ${unknown.join(", ")}. Options: ${allowed.join(", ")}.`);
        const args = { ...rest, ...params, locator: { ...query }, action: name, ...(timeout !== undefined ? { timeout } : {}) };
        if (!expect) return call("act_on_element", args);
        return call(`wait_for_${expect}`, {
          ...(timeout !== undefined ? { timeout } : {}), ...(tabAlias !== undefined ? { tabAlias } : {}),
          trigger: { name: "act_on_element", args: { ...args, tabRef } },
        });
      }
      const text = (method: string, field: string, value: unknown) => typeof value === "string" ? { [field]: value }
        : invalid(`${method} requires a string ${field}.`);
      const element = Object.freeze({
        nth(index: number) { return locator({ ...query, nth: index }); },
        async count() {
          const result = await boundCall("find_elements", { countOnly: true }) as { count: number };
          return result.count;
        },
        click(opts?: ActionOptions) { return action("click", {}, opts); },
        doubleClick(opts?: ActionOptions) { return action("double_click", {}, opts); },
        hover(opts?: ActionOptions) { return action("hover", {}, opts); },
        fill(value: string, opts?: ActionOptions) { return action("fill", text("fill", "value", value), opts); },
        press(key: string, opts?: ActionOptions) { return action("press", text("press", "key", key), opts); },
        select(value: string, opts?: ActionOptions) { return action("select", text("select", "value", value), opts); },
        check(opts?: ActionOptions) { return action("check", {}, opts); },
        uncheck(opts?: ActionOptions) { return action("uncheck", {}, opts); },
        scrollIntoView(opts?: ActionOptions) { return action("scroll", {}, opts); },
        /** Hidden compatibility for scrollIntoView. */
        scroll(opts?: ActionOptions) { return action("scroll", {}, opts); },
        dragTo(destination: object, opts?: ActionOptions) {
          const end = locators.get(destination);
          if (!end || end.tabRef !== tabRef) return invalid("Drag destination must be a locator bound to the same tabRef.");
          return action("drag", { destination: { locator: { ...end.query } } }, opts);
        },
        wait(opts: Arguments = {}) { return boundCall("wait_for_element", opts); },
        inspect(opts: Arguments = {}) { return boundCall("inspect_element", opts); },
        screenshot(opts: Arguments = {}) { return boundCall("screenshot", opts); },
        axTree(opts: Arguments = {}) { return boundCall("get_ax_tree", opts); },
        read(opts: Arguments = {}) {
          return boundCall("read_article", { limit: 4000, ...options(opts, ["source"]), source: "target" });
        },
      });
      locators.set(element, { tabRef, query });
      return element;
    }
    return Object.freeze({
      tabRef,
      locator,
      goto(url: string, opts: Arguments = {}) { return call("navigate", { ...options(opts, ["url"]), url }); },
      read(opts: Arguments = {}) { return call("read_article", { limit: 4000, ...opts }); },
      /** Every match as an Array, in the order of page.locator({...query, nth}). */
      find(opts: FindQuery = {}): Promise<ElementObservation[]> {
        const args = options(opts);
        if (Object.hasOwn(args, "countOnly")) return invalid("Use page.locator(query).count() to count matches.");
        return call("find_all_elements", serializePattern(args, "pattern"))
          .then(result => (result as { results: ElementObservation[] }).results);
      },
      axTree(opts: Arguments = {}) { return call("get_ax_tree", opts); },
      screenshot(opts: Arguments = {}) { return call("screenshot", opts); },
      scroll(opts: { direction?: "up" | "down" | "top" | "bottom"; pixels?: number; timeout?: number } = {}) {
        return call("scroll_page", options(opts, ["target", "locator", "nth", "index", "selector"]));
      },
      evaluate(code: PageFunction, args?: unknown, opts: Arguments = {}) {
        return call("evaluate", { ...options(opts, ["code", "args"]), code, ...(args !== undefined ? { args } : {}) });
      },
      close(opts: Arguments = {}) { return call("close_tab", opts); },
      setMode(mode: "desktop" | "mobile", opts: Arguments = {}) {
        return call("set_page_mode", { ...options(opts, ["mode"]), mode });
      },
      waitForURL(urlPattern: string | RegExp, opts: Arguments = {}) {
        if (!(urlPattern instanceof RegExp) && typeof urlPattern !== "string") return invalid("Pass a URL pattern string or RegExp.");
        return call("wait_for_url", serializePattern({ ...options(opts, ["urlPattern"]), urlPattern }, "urlPattern"));
      },
      waitForLoad(opts: Arguments = {}) { return call("wait_for_load", opts); },
      waitForFunction(code: PageFunction, args?: unknown, opts: Arguments = {}) {
        return call("wait_for_function", { ...options(opts, ["code", "args"]), code, ...(args !== undefined ? { args } : {}) });
      },
    });
  }
  return Object.freeze({
    tab,
    openTab(opts: Arguments) { return callTool("open_tab", options(opts)); },
    listTabs(opts: Arguments = {}) { return callTool("list_tabs", options(opts)); },
    listTools(opts: Arguments = {}) { return callTool("list_tools", options(opts)); },
    call(name: string, args: Arguments = {}) { return callTool(name, options(args)); },
  });
}
