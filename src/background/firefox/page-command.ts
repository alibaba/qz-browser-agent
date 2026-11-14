/**
 * One function injected by scripting.executeScript. Nested helpers stay inside so the
 * page receives them; this module must not call anything defined outside the function.
 */
export async function firefoxPageCommand(request: PageCommand, world: "MAIN" | "ISOLATED" = "ISOLATED"): Promise<unknown> {
  const page = globalThis as unknown as PageScope;
  const command = request || { op: "document" };
  const isolated = world !== "MAIN";
  const doc = page.document;
  if (!doc) throw new Error("Firefox page command has no document");

  const state: NonNullable<PageScope["__qzFirefoxPage"]> = page.__qzFirefoxPage?.version === 2 ? page.__qzFirefoxPage : (page.__qzFirefoxPage = {
    version: 2,
    next: 1,
    nextObject: 0,
    nodes: new Map(),
    nodeIds: new WeakMap(),
    objects: new Map(),
    mouseTarget: null,
    touchTarget: null,
  });

  const idFor = (node: DomNode | null | undefined): number => {
    if (!node) return 0;
    const existing = state.nodeIds.get(node);
    if (existing) return existing;
    const id = state.next++;
    state.nodeIds.set(node, id);
    state.nodes.set(id, new WeakRef(node));
    if (id % 256 === 0) for (const [key, reference] of state.nodes) if (!reference.deref()) state.nodes.delete(key);
    return id;
  };
  const retainObject = (value: DomNode | (DomNode | null)[], group = "") => {
    state.nextObject = (state.nextObject || 0) + 1;
    const objectId = `ff-object-${state.nextObject}`;
    state.objects.set(objectId, Array.isArray(value) ? { node: null, nodes: value, group } : { node: value, group });
    return objectId;
  };
  const nodeFor = (id: number): DomNode | null => state.nodes.get(Number(id))?.deref() || null;
  const asList = (nodes: ArrayLike<DomNode> | null | undefined): DomNode[] => {
    const out: DomNode[] = [];
    const length = Number(nodes?.length || 0);
    for (let index = 0; index < length; index += 1) {
      const node = nodes?.[index];
      if (node) out.push(node);
    }
    return out;
  };
  const attr = (node: DomNode, name: string): string => {
    try { return String(node.getAttribute?.(name) || ""); } catch { return ""; }
  };
  const remote = (value: unknown): Remote => {
    if (value === null) return { type: "object", subtype: "null", value: null };
    const type = typeof value;
    if (type === "undefined") return { type: "undefined" };
    if (type === "string" || type === "number" || type === "boolean") return { type, value };
    try { return { type: "object", value: JSON.parse(JSON.stringify(value)) }; }
    catch { return { type: "object", description: String(value) }; }
  };
  const failed = (error: unknown) => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { exceptionDetails: { text, exception: { type: "object", subtype: "error", description: text } } };
  };
  const invoke = async (declaration: string, target: unknown, args: unknown[], awaitPromise: boolean) => {
    // Firefox MV3 content-script CSP blocks Function() in the isolated world.
    if (isolated) throw new Error("Firefox isolated world cannot compile this function");
    const factory = page.Function;
    if (typeof factory !== "function") throw new Error("Firefox page command cannot compile a function");
    const fn = factory(`"use strict"; return (${declaration});`)() as (...values: unknown[]) => unknown;
    let value = fn.apply(target, args);
    if (awaitPromise && value && typeof (value as Promise<unknown>).then === "function") value = await value;
    return value;
  };
  const noted = (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const Marked = page.WeakSet;
    if (typeof Marked !== "function") return;
    const set = page.__qzExtensionInputEvents || (page.__qzExtensionInputEvents = new Marked());
    try { set.add(event); } catch { /* A stand-in event may not be a WeakSet key. */ }
  };
  const described = (node: DomNode | null) => {
    if (!node) return { node: { nodeId: 0, backendNodeId: 0, nodeName: "", nodeType: 0 } };
    const id = idFor(node);
    const name = String(node.nodeName || "");
    const result: Described = { nodeId: id, backendNodeId: id, nodeName: name, nodeType: Number(node.nodeType || 1) };
    if (name === "IFRAME" || name === "FRAME") {
      try {
        const child = node.contentDocument;
        if (child) result.contentDocument = { backendNodeId: idFor(child) };
      } catch { /* Cross-origin frames are a separate debugger session. */ }
    }
    return { node: result };
  };
  const quad = (node: DomNode) => {
    const rect = node.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
    const x = Number(rect.x || rect.left || 0);
    const y = Number(rect.y || rect.top || 0);
    const width = Number(rect.width || 0);
    const height = Number(rect.height || 0);
    return { x, y, width, height, content: [x, y, x + width, y, x + width, y + height, x, y + height] };
  };
  const makeEvent = (type: string, init: Record<string, unknown>) => {
    const wheel = type === "wheel";
    const ctor = wheel ? page.WheelEvent : page.MouseEvent;
    if (typeof ctor === "function") {
      try { return new ctor(type, init); } catch { /* The test page supplies a plain event. */ }
    }
    return { type, ...init };
  };
  const dispatch = (target: DomNode | null | undefined, type: string, init: Record<string, unknown>) => {
    const x = Number(init.clientX);
    const y = Number(init.clientY);
    if (!target || typeof target.dispatchEvent !== "function") {
      throw new Error(`Firefox could not dispatch ${type}: the page has no element at (${x}, ${y}).`);
    }
    const event = makeEvent(type, init);
    noted(event);
    try { return target.dispatchEvent(event) !== false; }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`Firefox could not dispatch ${type} at (${x}, ${y}): ${text}`);
    }
  };
  const buttonIndex = (button: unknown) => button === "right" ? 2 : button === "middle" ? 1 : 0;
  const pointer = (target: DomNode | null | undefined, type: string, init: Record<string, unknown>) => {
    const Ctor = page.PointerEvent;
    if (!target || typeof target.dispatchEvent !== "function" || typeof Ctor !== "function") return true;
    const event = new Ctor(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true });
    noted(event);
    try { return target.dispatchEvent(event) !== false; }
    catch { return true; /* The page has no pointer events. Mouse events still fire. */ }
  };
  const elementAtPoint = (x: number, y: number): DomNode | null => {
    let target = doc.elementFromPoint?.(x, y) || doc.documentElement || null;
    const visited = new Set<DomNode>();
    while (target && !visited.has(target)) {
      visited.add(target);
      const inner = target.shadowRoot?.elementFromPoint?.(x, y);
      if (!inner || inner === target) break;
      target = inner;
    }
    return target;
  };
  const activeElement = (): DomNode | null => {
    let target = doc.activeElement || null;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    return target;
  };
  const mouse = (input: MouseInput) => {
    const x = Number(input.x);
    const y = Number(input.y);
    const type = String(input.type || "");
    if (type === "mouseReleased" && (x < 0 || y < 0)) {
      const pressed = state.mouseTarget;
      state.mouseTarget = null;
      const suppressed = state.mouseEventsSuppressed;
      state.mouseEventsSuppressed = false;
      if (pressed) {
        const init = { bubbles: true, cancelable: true, composed: true, clientX: 0, clientY: 0, button: buttonIndex(input.button), buttons: 0 };
        pointer(pressed, "pointerup", init);
        if (!suppressed) dispatch(pressed, "mouseup", init);
      }
      return {};
    }
    const target = elementAtPoint(x, y);
    const button = buttonIndex(input.button);
    const clickCount = Number(input.clickCount) || 1;
    const buttons = input.buttons ?? (type === "mousePressed" ? (button === 1 ? 4 : button === 2 ? 2 : 1) : 0);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons,
      detail: type === "mousePressed" || type === "mouseReleased" ? clickCount : 0 };
    if (type === "mousePressed") {
      state.mouseTarget = target;
      state.mouseEventsSuppressed = !pointer(target, "pointerdown", init);
      if (!state.mouseEventsSuppressed && dispatch(target, "mousedown", init)) {
        try { target?.focus?.(); } catch { /* The element is not focusable. */ }
      }
    } else if (type === "mouseReleased") {
      const pressed = state.mouseTarget;
      state.mouseTarget = null;
      const suppressed = state.mouseEventsSuppressed;
      state.mouseEventsSuppressed = false;
      pointer(target, "pointerup", init);
      if (!suppressed) dispatch(target, "mouseup", init);
      if (pressed === target) {
        dispatch(target, "click", init);
        if (clickCount === 2) dispatch(target, "dblclick", init);
      }
    } else if (type === "mouseMoved") {
      pointer(target, "pointermove", init);
      if (!state.mouseEventsSuppressed) dispatch(target, "mousemove", init);
    } else if (type === "mouseWheel") {
      dispatch(target, "wheel", { ...init, deltaX: Number(input.deltaX || 0), deltaY: Number(input.deltaY || 0) });
      const scroller = doc.scrollingElement;
      if (scroller) {
        scroller.scrollLeft = Number(scroller.scrollLeft || 0) + Number(input.deltaX || 0);
        scroller.scrollTop = Number(scroller.scrollTop || 0) + Number(input.deltaY || 0);
      }
    }
    return {};
  };
  const insertText = (target: DomNode | null, text: string, required: boolean) => {
    if (!text) return;
    try { if (doc.execCommand?.("insertText", false, text)) return; }
    catch { /* The page rejected the untrusted insert. A value edit may still apply. */ }
    if (target && "value" in target && target.readOnly !== true && target.disabled !== true) {
      const start = Number(target.selectionStart ?? String(target.value || "").length);
      const end = Number(target.selectionEnd ?? start);
      const current = String(target.value || "");
      const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
      const proto = String(target.nodeName) === "TEXTAREA" ? page.HTMLTextAreaElement?.prototype : page.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
      if (typeof setter === "function") setter.call(target, next);
      else target.value = next;
      const caret = start + text.length;
      target.selectionStart = caret;
      target.selectionEnd = caret;
      const InputEvent = page.InputEvent;
      if (typeof InputEvent === "function") {
        const event = new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" });
        noted(event);
        try { target.dispatchEvent?.(event); }
        catch { /* The value is updated even when the page refuses the input event. */ }
      }
      return;
    }
    if (target?.isContentEditable && target.appendChild) {
      const node = doc.createTextNode?.(text);
      if (node) { target.appendChild(node); return; }
    }
    if (required) throw new Error("Firefox could not insert text. Focus an editable element, or the page refused the untrusted insert.");
  };
  const applyCommand = (command: string) => {
    let applied = false;
    try { applied = doc.execCommand?.(command) === true; }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`Firefox could not ${command}: ${text}`);
    }
    if (applied) return;
    if (command === "paste") throw new Error("Firefox could not paste. The focused element is not editable, or the page has no clipboard permission.");
    if (command === "copy" || command === "cut") throw new Error(`Firefox could not ${command}. The focused element has no selection, or the page has no clipboard permission.`);
    throw new Error("Firefox could not select all. The focused element is not editable.");
  };
  const blocksImplicitSubmission = (node: DomNode) => String(node.nodeName).toUpperCase() === "INPUT"
    && ["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time", "datetime-local", "number"]
      .includes(String(node.type || attr(node, "type") || "text").toLowerCase());
  const implicitSubmit = (target: DomNode) => {
    const form = target.form;
    if (!form || !blocksImplicitSubmission(target) || target.disabled || target.matches?.(":disabled")) return;
    // Tree order includes controls associated through form= outside the form.
    // form.elements omits input[type=image]; a form can also live in a shadow tree.
    const controls = asList((target.getRootNode?.() || target.ownerDocument || doc).querySelectorAll?.("input,button"))
      .filter(node => node.form === form);
    const submitter = controls.find(node => {
      const tag = String(node.nodeName).toUpperCase();
      const type = String(node.type || attr(node, "type") || (tag === "BUTTON" ? "submit" : "text")).toLowerCase();
      return tag === "BUTTON" ? type === "submit" : type === "submit" || type === "image";
    });
    if (submitter) {
      if (!submitter.disabled && !submitter.matches?.(":disabled")) submitter.click?.();
    } else if (controls.filter(blocksImplicitSubmission).length === 1) {
      form.requestSubmit?.();
    }
  };
  const keyboardActivates = (target: DomNode, space: boolean) => {
    if (target.disabled || target.matches?.(":disabled")) return false;
    const tag = String(target.nodeName).toUpperCase();
    const type = String(target.type || "").toLowerCase();
    return tag === "BUTTON" || (tag === "INPUT" && (["button", "submit", "reset", "image"].includes(type) || (space && ["checkbox", "radio"].includes(type))))
      || (!space && (tag === "A" || tag === "AREA") && target.hasAttribute?.("href"));
  };
  const activate = (target: DomNode) => dispatch(target, "click", { bubbles: true, cancelable: true, composed: true, detail: 0, button: 0, buttons: 0 });
  const key = (input: KeyInput) => {
    const releasing = input.type === "keyUp";
    const target = activeElement() || doc.body || doc.documentElement;
    const label = String(input.key || input.code || "key");
    if (!target || typeof target.dispatchEvent !== "function") {
      throw new Error(`Firefox could not press ${label}: the page has no focused element.`);
    }
    const modifiers = Number(input.modifiers || 0);
    const space = input.key === " " || input.code === "Space";
    const spaceTarget = state.spaceTarget;
    if (space) state.spaceTarget = null;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: String(input.key || ""),
      code: String(input.code || ""),
      keyCode: Number(input.keyCode || 0),
      altKey: (modifiers & 1) !== 0,
      ctrlKey: (modifiers & 2) !== 0,
      metaKey: (modifiers & 4) !== 0,
      shiftKey: (modifiers & 8) !== 0,
    };
    const ctor = page.KeyboardEvent;
    const event = typeof ctor === "function" ? new ctor(releasing ? "keyup" : "keydown", init) : { type: releasing ? "keyup" : "keydown", ...init };
    noted(event);
    let allowed = true;
    try { allowed = target.dispatchEvent(event) !== false; }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`Firefox could not press ${label}: ${text}`);
    }
    if (releasing) {
      if (allowed && space && spaceTarget === target && keyboardActivates(target, true)) activate(target);
      return {};
    }
    if (!allowed) return {};
    if (space && modifiers === 0) {
      if (keyboardActivates(target, true)) state.spaceTarget = target;
      const press = typeof ctor === "function" ? new ctor("keypress", init) : { type: "keypress", ...init };
      noted(press);
      const accepted = target.dispatchEvent(press) !== false;
      if (state.spaceTarget || !accepted) return {};
    }
    if (input.key === "Enter" && modifiers === 0) {
      const press = typeof ctor === "function" ? new ctor("keypress", init) : { type: "keypress", ...init };
      noted(press);
      if (target.dispatchEvent(press) === false) return {};
      if (keyboardActivates(target, false)) activate(target);
      else if (String(target.nodeName).toUpperCase() === "TEXTAREA" || target.isContentEditable) {
        insertText(target, "\n", false);
      } else implicitSubmit(target);
      return {};
    }
    if (modifiers === 0 && (input.key === "Backspace" || input.key === "Delete")) {
      if (target.disabled || target.readOnly || target.matches?.(":disabled")) return {};
      const editable = target.isContentEditable || String(target.nodeName).toUpperCase() === "TEXTAREA"
        || (String(target.nodeName).toUpperCase() === "INPUT" && ["text", "search", "url", "tel", "email", "password", "number"].includes(String(target.type || "text")));
      if (!editable) return {};
      const backward = input.key === "Backspace";
      if (typeof page.InputEvent === "function") {
        const before = new page.InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true,
          inputType: backward ? "deleteContentBackward" : "deleteContentForward", data: null });
        noted(before);
        if (target.dispatchEvent(before) === false) return {};
      }
      // Let the editing engine handle selections, graphemes and contenteditable ranges.
      doc.execCommand?.(backward ? "delete" : "forwardDelete");
      return {};
    }
    if (input.key === "Tab" && (modifiers & ~8) === 0) {
      throw new Error("Firefox cannot perform native Tab focus navigation. Focus the next element explicitly.");
    }
    if (input.text) insertText(target, String(input.text), false);
    for (const command of input.commands || []) {
      if (command === "selectAll" || command === "copy" || command === "paste" || command === "cut") applyCommand(command);
    }
    return {};
  };
  const touch = (input: TouchInput) => {
    const x = Number(input.x || 0);
    const y = Number(input.y || 0);
    const type = String(input.type || "");
    const target = type === "touchStart" || type === "touchMove"
      ? elementAtPoint(x, y)
      : state.touchTarget || elementAtPoint(x, y);
    try {
      if (typeof page.Touch === "function" && typeof page.TouchEvent === "function" && target) {
        const point = new page.Touch({ identifier: 0, target, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 1, radiusY: 1, force: 1, rotationAngle: 0 });
        const name = type === "touchStart" ? "touchstart" : type === "touchMove" ? "touchmove" : type === "touchEnd" ? "touchend" : "touchcancel";
        const empty = type === "touchEnd" || type === "touchCancel";
        const event = new page.TouchEvent(name, {
          bubbles: true, cancelable: true, composed: true,
          touches: empty ? [] : [point],
          targetTouches: empty ? [] : [point],
          changedTouches: [point],
        });
        noted(event);
        target.dispatchEvent?.(event);
        state.touchTarget = empty ? null : target || null;
        return {};
      }
    } catch { /* Touch constructors are missing; a mouse event still moves the element. */ }
    if (type === "touchStart") return mouse({ kind: "mouse", type: "mousePressed", x, y, button: "left", clickCount: 1 });
    if (type === "touchMove") return mouse({ kind: "mouse", type: "mouseMoved", x, y, button: "left" });
    if (type === "touchEnd") return mouse({ kind: "mouse", type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return mouse({ kind: "mouse", type: "mouseReleased", x: -1, y: -1, button: "left" });
  };
  const scrollerOf = () => (doc.scrollingElement || doc.documentElement || null) as {
    scrollLeft?: number; scrollTop?: number; scrollWidth?: number; scrollHeight?: number; clientWidth?: number; clientHeight?: number;
  } | null;
  const metrics = () => {
    const scroller = scrollerOf();
    const view = doc.defaultView;
    const clientWidth = Number(scroller?.clientWidth || view?.innerWidth || 0);
    const clientHeight = Number(scroller?.clientHeight || view?.innerHeight || 0);
    const pageX = Number(view?.scrollX ?? scroller?.scrollLeft ?? 0);
    const pageY = Number(view?.scrollY ?? scroller?.scrollTop ?? 0);
    const scale = Number(view?.visualViewport?.scale || 1) || 1;
    return {
      cssVisualViewport: { pageX, pageY, clientWidth, clientHeight, scale, zoom: scale },
      cssLayoutViewport: { pageX, pageY, clientWidth, clientHeight },
      cssContentSize: {
        width: Number(scroller?.scrollWidth || clientWidth),
        height: Number(scroller?.scrollHeight || clientHeight),
      },
    };
  };
  const ax = (depthLimit: number | undefined) => {
    const semantics = page.__qzDomSemantics;
    if (semantics?.version !== 1) throw new Error("Content DOM semantics are not ready");
    return semantics.read(() => {
      const nodes: Ax[] = [];
      const rootId = "ax-root";
      const root: Ax = {
        nodeId: rootId,
        role: { value: "RootWebArea" },
        name: { value: String(doc.title || "").slice(0, 200) },
        childIds: [],
        backendDOMNodeId: idFor(doc),
      };
      nodes.push(root);
      const parents = new Map<string, Ax>([[rootId, root]]);
      let visited = 0;
      const visit = (node: DomNode, depth: number, parentId: string, textAllowed = false, domDepth = 0) => {
        // Hidden and generic nodes still consume traversal budget even when omitted from AX.
        if (++visited > 40000 || domDepth > 256 || nodes.length >= 4000) return;
        if (depthLimit != null && depth > depthLimit) return;
        if (Number(node.nodeType) === 3) {
          const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
          if (!textAllowed || !text || !semantics.textVisible(node)) return;
          const id = `ax-${nodes.length}`;
          nodes.push({ nodeId: id, parentId, role: { value: "StaticText" }, name: { value: text },
            backendDOMNodeId: idFor(node), childIds: [] });
          parents.get(parentId)?.childIds?.push(id);
          return;
        }
        const hidden = semantics.hidden(node);
        const semanticRole = semantics.role(node);
        const documentRoot = node === doc.documentElement && semanticRole === "document";
        // CDP names images differently and retains frame owners for child-session grafting.
        const role = semanticRole === "img" ? "image" : semanticRole
          || (["IFRAME", "FRAME"].includes(String(node.nodeName).toUpperCase()) ? "Iframe" : "generic");
        const name = hidden || documentRoot ? "" : semantics.name(node);
        const shadowBoundary = shadowNote(node);
        const frameBoundary = frameNote(node);
        const keep = !hidden && !documentRoot
          && ((role !== "generic" && role !== "none" && role !== "") || shadowBoundary !== "" || frameBoundary !== "");
        const id = keep || name ? `ax-${nodes.length}` : parentId;
        let marked: Ax | undefined;
        if (keep || name) {
          const properties: { name: string; value: { value: unknown } }[] = [];
          const flag = (key: string, value: unknown) => {
            if (value === true || value === false || (typeof value === "string" && value)) properties.push({ name: key, value: { value } });
          };
          flag("focused", doc.activeElement === node);
          flag("disabled", node.disabled === true || attr(node, "aria-disabled") === "true");
          const expanded = attr(node, "aria-expanded");
          if (expanded === "true" || expanded === "false") flag("expanded", expanded === "true");
          if ("checked" in node) flag("checked", node.checked === true);
          const selected = attr(node, "aria-selected");
          if (selected === "true" || selected === "false") flag("selected", selected === "true");
          flag("editable", node.isContentEditable === true || role === "textbox");
          flag("readonly", node.readOnly === true);
          flag("required", node.required === true);
          if (role === "link") flag("url", attr(node, "href"));
          if (shadowBoundary) properties.push({ name: "shadowBoundary", value: { value: shadowBoundary } });
          if (frameBoundary) properties.push({ name: "frameBoundary", value: { value: frameBoundary } });
          const axNode: Ax = {
            nodeId: id,
            parentId,
            role: { value: role === "generic" ? "generic" : role },
            name: name ? { value: name } : undefined,
            childIds: [],
            backendDOMNodeId: idFor(node),
            properties,
          };
          nodes.push(axNode);
          parents.set(id, axNode);
          marked = axNode;
          const parent = parents.get(parentId);
          parent?.childIds?.push(id);
        }
        const nested = frameDocument(node);
        const shadows = shadowChildren(node);
        const children = asList(node.childNodes || node.children).filter(child => [1, 3].includes(Number(child.nodeType)));
        if (depthLimit != null && depth >= depthLimit) {
          if (marked && (children.length || shadows.length || nested)) marked.properties?.push({ name: "depthBoundary", value: { value: "children below this depth were omitted" } });
          return;
        }
        const nextDepth = keep || name ? depth + 1 : depth;
        for (const child of children) {
          if (visited >= 40000 || nodes.length >= 4000) break;
          visit(child, nextDepth, id, !hidden, domDepth + 1);
        }
        // Child documents have independent isolated-world registries. The host
        // grafts their AX trees through frame sessions, never parent-world nodes.
        for (const child of shadows) {
          if (visited >= 40000 || nodes.length >= 4000) break;
          visit(child, nextDepth, id, !hidden, domDepth + 1);
        }
      };
      if (doc.documentElement) visit(doc.documentElement, 1, rootId);
      return { nodes };
    });
  };
  const elementChildren = (node: DomNode | null | undefined): DomNode[] => asList(node?.children || node?.childNodes).filter(child => Number(child.nodeType) === 1);
  const shadowChildren = (node: DomNode): DomNode[] => {
    try { return asList(node.shadowRoot?.childNodes || node.shadowRoot?.children).filter(child => [1, 3].includes(Number(child.nodeType))); }
    catch { return []; }
  };
  const frameDocument = (node: DomNode): DomNode | null => {
    const name = String(node.nodeName || "").toUpperCase();
    if (name !== "IFRAME" && name !== "FRAME") return null;
    try { return node.contentDocument?.documentElement || null; }
    catch { return null; }
  };
  const shadowNote = (node: DomNode): string => {
    try {
      void node.shadowRoot;
      return "";
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return `shadow root could not be read: ${text}`;
    }
  };
  const frameNote = (node: DomNode): string => {
    const name = String(node.nodeName || "").toUpperCase();
    if (name !== "IFRAME" && name !== "FRAME") return "";
    try {
      if (node.contentDocument?.documentElement) return "";
      return "nested frame has no document";
    } catch {
      return "cross-origin nested frame is not included";
    }
  };

  try {
    switch (command.op) {
      case "document": {
        const id = idFor(doc);
        return { root: { nodeId: id, backendNodeId: id, nodeName: "#document", nodeType: 9 } };
      }
      case "query": {
        const node = nodeFor(command.nodeId);
        const found = node && typeof node.querySelectorAll === "function" ? asList(node.querySelectorAll(command.selector || "")) : [];
        return { nodeIds: found.map(idFor) };
      }
      case "describe":
        return described(command.objectId ? state.objects.get(command.objectId)?.node || null
          : command.backendNodeId ? nodeFor(command.backendNodeId) : nodeFor(Number(command.nodeId || 0)));
      case "push":
        return { nodeIds: (command.backendNodeIds || []).map(id => nodeFor(Number(id)) ? Number(id) : 0) };
      case "rects": {
        const rects = [];
        for (const backendNodeId of new Set(command.backendNodeIds)) {
          const node = nodeFor(backendNodeId);
          if (!node?.getBoundingClientRect) continue;
          try {
            const { x, y, width, height } = quad(node);
            if ([x, y, width, height].every(Number.isFinite)) rects.push({ backendNodeId, x, y, width, height });
          } catch { /* Detached/unmeasurable nodes do not discard the rest of the batch. */ }
        }
        return { rects };
      }
      case "box": {
        const node = nodeFor(command.backendNodeId);
        if (!node?.getBoundingClientRect) throw new Error("Node is not laid out");
        const box = quad(node);
        if (box.width <= 0 || box.height <= 0) throw new Error("Node has no box");
        return { model: { content: box.content, padding: box.content, border: box.content, margin: box.content, width: box.width, height: box.height } };
      }
      case "resolve": {
        const node = nodeFor(command.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        const objectId = retainObject(node, String(command.objectGroup || ""));
        return { object: { type: "object", subtype: "node", objectId, description: String(node.nodeName || "") } };
      }
      case "probe": {
        let extensionId = "";
        try { extensionId = String(page.chrome?.runtime?.id || ""); } catch { extensionId = ""; }
        return { result: remote({ extensionId, bridge: typeof page.__qzInvoke === "function", elementRefs: page.__qzElementRefVersion === 1 }) };
      }
      case "invoke": {
        const bound = state.objects.get(String(command.objectId || ""));
        if (command.objectId && !bound) return failed(new Error("Cannot find object"));
        const fn = page.__qzInvoke;
        if (typeof fn !== "function") throw new Error("Content script bridge is missing");
        let value: unknown = fn.call(bound?.node, bound?.node || null, command.payload);
        if (command.awaitPromise !== false && value && typeof (value as Promise<unknown>).then === "function") value = await value;
        if (command.returnByValue === false && value && typeof value === "object" && "nodeType" in value && value.nodeType === 1) {
          const node = value as DomNode;
          const objectId = retainObject(node, String(command.objectGroup || ""));
          return { result: { type: "object", subtype: "node", objectId } };
        }
        if (command.returnByValue === false && Array.isArray(value)) {
          const objectId = retainObject(value as (DomNode | null)[], String(command.objectGroup || ""));
          return { result: { type: "object", subtype: "array", objectId } };
        }
        return { result: remote(value) };
      }
      case "properties": {
        const bound = state.objects.get(command.objectId);
        return { result: (bound?.nodes || []).map((node: DomNode | null, index: number) => {
          if (!node || typeof node.nodeType !== "number") return { name: String(index), value: remote(node) };
          const objectId = retainObject(node, bound?.group || "");
          return { name: String(index), value: { type: "object", subtype: "node", objectId } };
        }) };
      }
      case "call": {
        const bound = state.objects.get(String(command.objectId || ""));
        if (!bound) return failed(new Error("Cannot find object"));
        const args = (command.arguments || []).map(item => item && typeof item === "object" && "value" in item ? item.value : item);
        const value = await invoke(String(command.functionDeclaration || "function(){return undefined}"), bound.node, args, command.awaitPromise !== false);
        return { result: remote(value) };
      }
      case "evaluate": {
        const value = await invoke(`function(){ return (${command.expression}); }`, doc.defaultView || null, [], command.awaitPromise === true);
        return { result: remote(value) };
      }
      case "release": {
        const group = String(command.objectGroup || "");
        for (const [objectId, bound] of state.objects) if (!group || bound.group === group) state.objects.delete(objectId);
        return {};
      }
      case "semantics":
        return page.__qzDomSemantics?.version || 0;
      case "ax":
        return ax(typeof command.depth === "number" ? command.depth : undefined);
      case "layout":
        return metrics();
      case "owners": {
        const frames = asList(doc.querySelectorAll?.("iframe,frame"));
        return {
          frames: frames.map((frame, index) => {
            let childUrl = "";
            try { childUrl = String(frame.contentWindow?.location?.href || ""); } catch { childUrl = ""; }
            return { index, url: attr(frame, "src"), childUrl, backendNodeId: idFor(frame) };
          }),
        };
      }
      case "scroll": {
        const scroller = scrollerOf();
        if (scroller && command.x != null) scroller.scrollLeft = Number(command.x);
        if (scroller && command.y != null) scroller.scrollTop = Number(command.y);
        const current = metrics();
        return {
          scrollX: current.cssVisualViewport.pageX,
          scrollY: current.cssVisualViewport.pageY,
          clientWidth: current.cssVisualViewport.clientWidth,
          clientHeight: current.cssVisualViewport.clientHeight,
          scrollWidth: current.cssContentSize.width,
          scrollHeight: current.cssContentSize.height,
        };
      }
      case "inputFrame": {
        const target = command.active ? activeElement() : elementAtPoint(command.x, command.y);
        if (!target || !["IFRAME", "FRAME"].includes(String(target.nodeName).toUpperCase())) return {};
        const rect = quad(target);
        return { backendNodeId: idFor(target), x: command.x - rect.x - Number(target.clientLeft || 0),
          y: command.y - rect.y - Number(target.clientTop || 0) };
      }
      case "input": {
        const input = command.input;
        switch (input.kind) {
          case "mouse": return mouse(input);
          case "key": return key(input);
          case "text":
            insertText(activeElement(), String(input.text || ""), true);
            return {};
          case "touch": return touch(input);
          default: {
            const unknown: never = input;
            throw new Error(`Unknown Firefox input ${String(unknown)}`);
          }
        }
      }
      default: {
        const unknown: never = command;
        throw new Error(`Unknown Firefox page command ${String(unknown)}`);
      }
    }
  } catch (error) {
    if (command.op === "evaluate" || command.op === "call" || command.op === "probe" || command.op === "invoke") return failed(error);
    throw error;
  }
}

export function firefoxApplyUserAgent(userAgent: string): void {
  const page = globalThis as unknown as PageScope;
  const proto = page.Navigator?.prototype;
  if (!proto) return;
  const holder = page as PageScope & { __qzNativeUserAgent?: PropertyDescriptor };
  if (!holder.__qzNativeUserAgent) holder.__qzNativeUserAgent = Object.getOwnPropertyDescriptor(proto, "userAgent");
  if (!userAgent && holder.__qzNativeUserAgent) {
    Object.defineProperty(proto, "userAgent", holder.__qzNativeUserAgent);
    return;
  }
  Object.defineProperty(proto, "userAgent", { configurable: true, get: () => userAgent });
}

export function firefoxConsoleMain(): void {
  const page = globalThis as unknown as PageScope;
  const root = page.document?.documentElement;
  if (!root?.setAttribute || root.getAttribute?.("data-qz-console-hook") === "1") return;
  root.setAttribute("data-qz-console-hook", "1");
  const queue: { seq: number; record: ConsoleRecord }[] = [];
  let seq = 0;
  const push = (record: ConsoleRecord) => {
    seq += 1;
    queue.push({ seq, record: { ...record, timestamp: Date.now() } });
    if (queue.length > 200) queue.shift();
    root.setAttribute?.("data-qz-console-queue", JSON.stringify(queue));
  };
  const frame = () => String(new page.Error().stack || "");
  const consoleApi = page.console;
  if (consoleApi) {
    for (const level of ["debug", "log", "info", "warn", "error"] as const) {
      const original = consoleApi[level];
      consoleApi[level] = (...args: unknown[]) => {
        push({ kind: "console", type: level, args: args.slice(0, 20).map(value => String(value).slice(0, 500)), stack: frame() });
        if (typeof original === "function") return original.apply(consoleApi, args);
        return undefined;
      };
    }
  }
  page.addEventListener?.("error", event => {
    const info = event as { message?: string; filename?: string; lineno?: number; colno?: number };
    push({ kind: "exception", text: String(info.message || "error"), url: String(info.filename || ""), line: Number(info.lineno || 0), column: Number(info.colno || 0), stack: frame() });
  });
  page.addEventListener?.("unhandledrejection", event => {
    const info = event as { reason?: unknown };
    push({ kind: "exception", text: String(info.reason || "unhandledrejection"), stack: frame() });
  });
}

export function firefoxConsoleBridge(replay = false): void {
  const page = globalThis as unknown as PageScope;
  const root = page.document?.documentElement;
  if (!root?.getAttribute || (root.__qzConsoleBridge && !replay)) return;
  const installed = root.__qzConsoleBridge;
  root.__qzConsoleBridge = true;
  root.__qzConsoleSeen = 0;
  const flush = () => {
    let queue: { seq?: number; record?: ConsoleRecord }[] = [];
    try { queue = JSON.parse(root.getAttribute?.("data-qz-console-queue") || "[]"); } catch { return; }
    let last = Number(root.__qzConsoleSeen || 0);
    for (const item of queue) {
      const seq = Number(item?.seq || 0);
      if (!item?.record || seq <= last) continue;
      last = seq;
      page.chrome?.runtime?.sendMessage?.({ type: "qz-firefox-console", record: item.record });
    }
    root.__qzConsoleSeen = last;
  };
  const Observer = page.MutationObserver;
  if (!installed && typeof Observer === "function") new Observer(flush).observe(root, { attributes: true, attributeFilter: ["data-qz-console-queue"] });
  flush();
}

export type PageCommand =
  | { op: "document" }
  | { op: "query"; nodeId: number; selector: string }
  | { op: "describe"; nodeId?: number; backendNodeId?: number; objectId?: string }
  | { op: "push"; backendNodeIds: number[] }
  | { op: "box"; backendNodeId: number }
  | { op: "rects"; backendNodeIds: number[] }
  | { op: "resolve"; backendNodeId: number; objectGroup?: string }
  | { op: "call"; objectId: string; functionDeclaration: string; arguments?: { value?: unknown }[]; awaitPromise?: boolean }
  | { op: "probe" }
  | { op: "invoke"; objectId: string; payload?: unknown; awaitPromise?: boolean; returnByValue?: boolean; objectGroup?: string }
  | { op: "properties"; objectId: string }
  | { op: "evaluate"; expression: string; awaitPromise?: boolean }
  | { op: "release"; objectGroup?: string }
  | { op: "semantics" }
  | { op: "ax"; depth?: number }
  | { op: "layout" }
  | { op: "owners" }
  | { op: "scroll"; x?: number; y?: number }
  | { op: "inputFrame"; x: number; y: number; active?: boolean }
  | { op: "input"; input: InputCommand };

type InputCommand = MouseInput | KeyInput | { kind: "text"; text?: string } | TouchInput;
interface MouseInput { kind: "mouse"; type?: string; x?: number; y?: number; button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }
interface KeyInput { kind: "key"; type?: string; key?: string; code?: string; keyCode?: number; modifiers?: number; text?: string; commands?: string[] }
interface TouchInput { kind: "touch"; type?: string; x?: number; y?: number }

interface Remote { type: string; subtype?: string; value?: unknown; description?: string }
interface Described { nodeId: number; backendNodeId: number; nodeName: string; nodeType: number; contentDocument?: { backendNodeId: number } }
interface Ax {
  nodeId: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number;
  role?: { value: string }; name?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
}
interface ConsoleRecord { kind: "console" | "exception"; timestamp?: number; type?: string; text?: string; args?: string[]; stack?: string; url?: string; line?: number; column?: number }
interface DomNode {
  nodeType?: number; nodeName?: string; nodeValue?: string; textContent?: string; title?: string;
  childNodes?: ArrayLike<DomNode>; children?: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null; setAttribute?(name: string, value: string): void;
  hasAttribute?(name: string): boolean; getBoundingClientRect?(): { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number };
  querySelectorAll?(selector: string): ArrayLike<DomNode>; dispatchEvent?(event: unknown): boolean;
  elementFromPoint?(x: number, y: number): DomNode | null;
  contentDocument?: (DomNode & { documentElement?: DomNode | null }) | null; contentWindow?: { location?: { href?: string } } | null;
  shadowRoot?: DomNode | null; activeElement?: DomNode | null; focus?(): void; getRootNode?(): DomNode;
  ownerDocument?: DomNode; type?: string; matches?(selector: string): boolean; click?(): void;
  clientLeft?: number; clientTop?: number;
  form?: { requestSubmit?(submitter?: DomNode): void } | null;
  value?: string; selectionStart?: number | null; selectionEnd?: number | null;
  disabled?: boolean; checked?: boolean; readOnly?: boolean; required?: boolean; isContentEditable?: boolean;
  appendChild?(node: DomNode): void; __qzConsoleSeen?: number; __qzConsoleBridge?: boolean;
}
interface PageScope {
  document?: DomNode & {
    documentElement?: DomNode | null; body?: DomNode | null; activeElement?: DomNode | null; title?: string;
    scrollingElement?: { scrollLeft?: number; scrollTop?: number; scrollWidth?: number; scrollHeight?: number; clientWidth?: number; clientHeight?: number } | null;
    defaultView?: { scrollX?: number; scrollY?: number; innerWidth?: number; innerHeight?: number; visualViewport?: { scale?: number }; getComputedStyle?(node: DomNode): { display?: string; visibility?: string } };
    getElementById?(id: string): DomNode | null; createTextNode?(text: string): DomNode;
    elementFromPoint?(x: number, y: number): DomNode | null; execCommand?(command: string, showUI?: boolean, value?: string): boolean;
    querySelectorAll?(selector: string): ArrayLike<DomNode>;
  };
  Function?: (source: string) => () => (...args: unknown[]) => unknown;
  WeakSet?: new () => { add(value: object): void };
  MouseEvent?: new (type: string, init?: unknown) => unknown;
  WheelEvent?: new (type: string, init?: unknown) => unknown;
  KeyboardEvent?: new (type: string, init?: unknown) => unknown;
  PointerEvent?: new (type: string, init?: unknown) => unknown;
  InputEvent?: new (type: string, init?: unknown) => unknown;
  HTMLInputElement?: { prototype: object };
  HTMLTextAreaElement?: { prototype: object };
  Touch?: new (init: unknown) => unknown;
  TouchEvent?: new (type: string, init?: unknown) => unknown;
  Navigator?: { prototype: object };
  Error: new () => { stack?: string };
  console?: Record<string, (...args: unknown[]) => unknown>;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  MutationObserver?: new (callback: () => void) => { observe(target: DomNode, options: { attributes: boolean; attributeFilter: string[] }): void };
  chrome?: { runtime?: { id?: string; sendMessage?(message: unknown): void } };
  __qzInvoke?: (this: unknown, node: DomNode | null, payload: unknown) => unknown;
  __qzElementRefVersion?: number;
  __qzDomSemantics?: {
    version: number; role(node: DomNode): string; name(node: DomNode): string; hidden(node: DomNode): boolean;
    textVisible(node: DomNode): boolean;
    read<T>(observe: () => T): T;
  };
  __qzExtensionInputEvents?: { add(value: object): void };
  __qzFirefoxPage?: {
    version: number; next: number; nextObject?: number; nodes: Map<number, WeakRef<DomNode>>; nodeIds: WeakMap<DomNode, number>; objects: Map<string, { node: DomNode | null; nodes?: (DomNode | null)[]; group: string }>;
    mouseTarget: DomNode | null; mouseEventsSuppressed?: boolean; spaceTarget?: DomNode | null; touchTarget: DomNode | null;
  };
}
