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

  const state = page.__qzFirefoxPage || (page.__qzFirefoxPage = {
    next: 1,
    nodes: new Map(),
    objects: new Map(),
    mouseTarget: null,
    touchTarget: null,
  });

  const idFor = (node: DomNode | null | undefined): number => {
    if (!node) return 0;
    for (const [id, value] of state.nodes) if (value === node) return id;
    const id = state.next;
    state.next += 1;
    state.nodes.set(id, node);
    return id;
  };
  const nodeFor = (id: number): DomNode | null => state.nodes.get(Number(id)) || null;
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
    const text = error instanceof Error ? error.message : String(error);
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
  const checkable = (node: DomNode | null | undefined): "checkbox" | "radio" | "" => {
    if (!node || String(node.nodeName || "").toUpperCase() !== "INPUT" || node.disabled === true) return "";
    const type = String(node.getAttribute?.("type") || "").toLowerCase();
    return type === "checkbox" || type === "radio" ? type : "";
  };
  const applyCheck = (node: DomNode, type: "checkbox" | "radio") => {
    const next = type === "radio" ? true : node.checked !== true;
    if (node.checked === next) return;
    node.checked = next;
    const Change = page.Event;
    const event = typeof Change === "function" ? new Change("change", { bubbles: true }) : { type: "change", bubbles: true };
    noted(event);
    try { node.dispatchEvent?.(event); } catch { /* The checked state is already updated. */ }
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
    try { target.dispatchEvent(event); }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`Firefox could not dispatch ${type} at (${x}, ${y}): ${text}`);
    }
  };
  const buttonIndex = (button: unknown) => button === "right" ? 2 : button === "middle" ? 1 : 0;
  const pointer = (target: DomNode | null | undefined, type: string, init: Record<string, unknown>) => {
    const Ctor = page.PointerEvent;
    if (!target || typeof target.dispatchEvent !== "function" || typeof Ctor !== "function") return;
    const event = new Ctor(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true });
    noted(event);
    try { target.dispatchEvent(event); }
    catch { /* The page has no pointer events. Mouse events still fire. */ }
  };
  const activate = (target: DomNode | null | undefined) => {
    if (!target) return;
    const anchor = typeof target.closest === "function" ? target.closest("a[href]") : String(target.nodeName) === "A" ? target : null;
    const href = anchor ? String(anchor.href || anchor.getAttribute?.("href") || "") : "";
    if (anchor && href && !href.toLowerCase().startsWith("javascript:")) {
      const where = String(anchor.target || anchor.getAttribute?.("target") || "");
      if (where === "_blank") page.open?.(href, "_blank", "noopener");
      else page.location?.assign?.(href);
      return;
    }
    const control = String(target.nodeName || "").toUpperCase();
    const inputType = String(target.getAttribute?.("type") || "").toLowerCase();
    const form = target.form || (typeof target.closest === "function" ? target.closest("form") : null);
    const requestSubmit = form && "requestSubmit" in form && typeof form.requestSubmit === "function" ? form.requestSubmit : undefined;
    const submitter = control === "BUTTON" || inputType === "submit" || inputType === "image";
    if (!requestSubmit || !submitter || inputType === "button" || inputType === "reset") return;
    try { requestSubmit.call(form, target); }
    catch { /* The form rejected the submit. The click listeners still ran. */ }
  };
  const mouse = (input: MouseInput) => {
    const x = Number(input.x);
    const y = Number(input.y);
    const type = String(input.type || "");
    if (type === "mouseReleased" && (x < 0 || y < 0)) {
      if (state.mouseTarget) {
        pointer(state.mouseTarget, "pointerup", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 });
        dispatch(state.mouseTarget, "mouseup", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 });
      }
      state.mouseTarget = null;
      return {};
    }
    const target = doc.elementFromPoint?.(x, y) || doc.documentElement || null;
    const button = buttonIndex(input.button);
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: type === "mouseReleased" ? 0 : 1 };
    if (type === "mousePressed") {
      state.mouseTarget = target;
      try { target?.focus?.(); } catch { /* The element is not focusable. */ }
      pointer(target, "pointerdown", init);
      dispatch(target, "mousedown", init);
    } else if (type === "mouseReleased") {
      pointer(target, "pointerup", init);
      dispatch(target, "mouseup", init);
      if (state.mouseTarget === target) {
        const name = Number(input.clickCount) > 1 ? "dblclick" : "click";
        const event = makeEvent(name, init);
        noted(event);
        let allowed = true;
        if (!target || typeof target.dispatchEvent !== "function") {
          throw new Error(`Firefox could not dispatch ${name}: the page has no element at (${x}, ${y}).`);
        }
        const kind = checkable(target);
        const before = kind ? target.checked === true : null;
        try { allowed = target.dispatchEvent(event) !== false; }
        catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          throw new Error(`Firefox could not dispatch ${name} at (${x}, ${y}): ${text}`);
        }
        if (allowed && name === "click") {
          activate(target);
          // An untrusted click does not run the checkbox activation behavior.
          if (kind && target.checked === before) applyCheck(target, kind);
        }
      }
      state.mouseTarget = null;
    } else if (type === "mouseMoved") {
      pointer(target, "pointermove", init);
      dispatch(target, "mousemove", init);
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
        const event = new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" });
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
  const key = (input: KeyInput) => {
    const releasing = input.type === "keyUp";
    const target = doc.activeElement || doc.body || doc.documentElement;
    const label = String(input.key || input.code || "key");
    if (!target || typeof target.dispatchEvent !== "function") {
      throw new Error(`Firefox could not press ${label}: the page has no focused element.`);
    }
    const modifiers = Number(input.modifiers || 0);
    const init = {
      bubbles: true,
      cancelable: true,
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
    try { target.dispatchEvent(event); }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`Firefox could not press ${label}: ${text}`);
    }
    if (releasing) return {};
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
      ? doc.elementFromPoint?.(x, y) || doc.documentElement
      : state.touchTarget || doc.elementFromPoint?.(x, y) || doc.documentElement;
    try {
      if (typeof page.Touch === "function" && typeof page.TouchEvent === "function" && target) {
        const point = new page.Touch({ identifier: 0, target, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 1, radiusY: 1, force: 1, rotationAngle: 0 });
        const name = type === "touchStart" ? "touchstart" : type === "touchMove" ? "touchmove" : type === "touchEnd" ? "touchend" : "touchcancel";
        const empty = type === "touchEnd" || type === "touchCancel";
        const event = new page.TouchEvent(name, {
          bubbles: true, cancelable: true,
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
  const roleFor = (node: DomNode): string => {
    const explicit = attr(node, "role");
    if (explicit) return explicit;
    const name = String(node.nodeName || "").toUpperCase();
    if (name === "A") return node.hasAttribute?.("href") ? "link" : "generic";
    if (name === "BUTTON") return "button";
    if (name === "IMG") return "image";
    if (name === "NAV") return "navigation";
    if (name === "MAIN") return "main";
    if (name === "HEADER") return "banner";
    if (name === "FOOTER") return "contentinfo";
    if (name === "FORM") return "form";
    if (name === "UL" || name === "OL") return "list";
    if (name === "LI") return "listitem";
    if (name === "TABLE") return "table";
    if (name === "IFRAME" || name === "FRAME") return "Iframe";
    if (name === "TEXTAREA") return "textbox";
    if (name === "SELECT") return "combobox";
    if (/^H[1-6]$/.test(name)) return "heading";
    if (name === "P") return "paragraph";
    if (name === "INPUT") {
      const type = attr(node, "type").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    return "generic";
  };
  const ownText = (node: DomNode): string => {
    let out = "";
    for (const child of asList(node.childNodes)) {
      if (Number(child.nodeType) === 3) out += String(child.nodeValue || "");
    }
    return out.replace(/\s+/g, " ").trim().slice(0, 200);
  };
  const nameFor = (node: DomNode, role: string): string => {
    const labelled = attr(node, "aria-label");
    if (labelled) return labelled.slice(0, 200);
    const labelledBy = attr(node, "aria-labelledby");
    if (labelledBy && doc.getElementById) {
      const text = labelledBy.split(/\s+/).map(id => doc.getElementById?.(id)?.textContent || "").filter(Boolean).join(" ");
      if (text) return text.replace(/\s+/g, " ").trim().slice(0, 200);
    }
    if (String(node.nodeName) === "IMG") return attr(node, "alt").slice(0, 200);
    if ("value" in node && (role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio")) {
      return String(node.value || attr(node, "placeholder") || "").slice(0, 200);
    }
    if (role === "generic" || role === "none") return "";
    return ownText(node) || String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
  };
  const hidden = (node: DomNode): boolean => {
    try {
      if (attr(node, "aria-hidden") === "true") return true;
      const style = doc.defaultView?.getComputedStyle?.(node);
      return style?.display === "none" || style?.visibility === "hidden";
    } catch { return false; }
  };
  const ax = (depthLimit: number | undefined) => {
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
    const visit = (node: DomNode, depth: number, parentId: string) => {
      if (nodes.length >= 4000 || hidden(node)) return;
      if (depthLimit != null && depth > depthLimit) return;
      const role = roleFor(node);
      const name = nameFor(node, role);
      const shadowBoundary = shadowNote(node);
      const frameBoundary = frameNote(node);
      const keep = (role !== "generic" && role !== "none" && role !== "") || shadowBoundary !== "" || frameBoundary !== "";
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
        marked = axNode;
        const parent = nodes.find(item => item.nodeId === parentId);
        parent?.childIds?.push(id);
      }
      const nested = frameDocument(node);
      const shadows = shadowChildren(node);
      const children = asList(node.children || node.childNodes).filter(child => Number(child.nodeType) === 1);
      if (depthLimit != null && depth >= depthLimit) {
        if (marked && (children.length || shadows.length || nested)) marked.properties?.push({ name: "depthBoundary", value: { value: "children below this depth were omitted" } });
        return;
      }
      const nextDepth = keep || name ? depth + 1 : depth;
      for (const child of children) visit(child, nextDepth, id);
      if (nested) visit(nested, nextDepth, id);
      for (const child of shadows) visit(child, nextDepth, id);
    };
    if (doc.documentElement) visit(doc.documentElement, 1, rootId);
    return { nodes };
  };
  const elementChildren = (node: DomNode | null | undefined): DomNode[] => asList(node?.children || node?.childNodes).filter(child => Number(child.nodeType) === 1);
  const shadowChildren = (node: DomNode): DomNode[] => {
    try { return node.shadowRoot ? elementChildren(node.shadowRoot) : []; }
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
        return described(command.backendNodeId ? nodeFor(command.backendNodeId) : nodeFor(Number(command.nodeId || 0)));
      case "push":
        return { nodeIds: (command.backendNodeIds || []).map(id => nodeFor(Number(id)) ? Number(id) : 0) };
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
        const objectId = `ff-node-${command.backendNodeId}`;
        state.objects.set(objectId, { node, group: String(command.objectGroup || "") });
        return { object: { type: "object", subtype: "node", objectId, description: String(node.nodeName || "") } };
      }
      case "probe": {
        let extensionId = "";
        try { extensionId = String(page.chrome?.runtime?.id || ""); } catch { extensionId = ""; }
        return { result: remote({ extensionId, bridge: typeof page.__qzInvoke === "function" }) };
      }
      case "invoke": {
        const bound = state.objects.get(String(command.objectId || ""));
        if (!bound) return failed(new Error("Cannot find object"));
        const fn = page.__qzInvoke;
        if (typeof fn !== "function") throw new Error("Content script bridge is missing");
        let value: unknown = fn.call(bound.node, bound.node, command.payload);
        if (command.awaitPromise !== false && value && typeof (value as Promise<unknown>).then === "function") value = await value;
        return { result: remote(value) };
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
      case "input": {
        const input = command.input;
        switch (input.kind) {
          case "mouse": return mouse(input);
          case "key": return key(input);
          case "text":
            insertText(doc.activeElement || null, String(input.text || ""), true);
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
    queue.push({ seq, record });
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

export function firefoxConsoleBridge(): void {
  const page = globalThis as unknown as PageScope;
  const root = page.document?.documentElement;
  if (!root?.getAttribute || root.__qzConsoleBridge) return;
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
  if (typeof Observer === "function") new Observer(flush).observe(root, { attributes: true, attributeFilter: ["data-qz-console-queue"] });
  flush();
}

export type PageCommand =
  | { op: "document" }
  | { op: "query"; nodeId: number; selector: string }
  | { op: "describe"; nodeId?: number; backendNodeId?: number }
  | { op: "push"; backendNodeIds: number[] }
  | { op: "box"; backendNodeId: number }
  | { op: "resolve"; backendNodeId: number; objectGroup?: string }
  | { op: "call"; objectId: string; functionDeclaration: string; arguments?: { value?: unknown }[]; awaitPromise?: boolean }
  | { op: "probe" }
  | { op: "invoke"; objectId: string; payload?: unknown; awaitPromise?: boolean }
  | { op: "evaluate"; expression: string; awaitPromise?: boolean }
  | { op: "release"; objectGroup?: string }
  | { op: "ax"; depth?: number }
  | { op: "layout" }
  | { op: "owners" }
  | { op: "scroll"; x?: number; y?: number }
  | { op: "input"; input: InputCommand };

type InputCommand = MouseInput | KeyInput | { kind: "text"; text?: string } | TouchInput;
interface MouseInput { kind: "mouse"; type?: string; x?: number; y?: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }
interface KeyInput { kind: "key"; type?: string; key?: string; code?: string; keyCode?: number; modifiers?: number; text?: string; commands?: string[] }
interface TouchInput { kind: "touch"; type?: string; x?: number; y?: number }

interface Remote { type: string; subtype?: string; value?: unknown; description?: string }
interface Described { nodeId: number; backendNodeId: number; nodeName: string; nodeType: number; contentDocument?: { backendNodeId: number } }
interface Ax {
  nodeId: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number;
  role?: { value: string }; name?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
}
interface ConsoleRecord { kind: "console" | "exception"; type?: string; text?: string; args?: string[]; stack?: string; url?: string; line?: number; column?: number }
interface DomNode {
  nodeType?: number; nodeName?: string; nodeValue?: string; textContent?: string; title?: string;
  childNodes?: ArrayLike<DomNode>; children?: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null; setAttribute?(name: string, value: string): void;
  hasAttribute?(name: string): boolean; getBoundingClientRect?(): { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number };
  querySelectorAll?(selector: string): ArrayLike<DomNode>; dispatchEvent?(event: unknown): boolean;
  contentDocument?: (DomNode & { documentElement?: DomNode | null }) | null; contentWindow?: { location?: { href?: string } } | null;
  shadowRoot?: DomNode | null; focus?(): void; closest?(selector: string): DomNode | null;
  href?: string; target?: string; form?: { requestSubmit?(submitter?: DomNode): void } | null;
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
  Event?: new (type: string, init?: unknown) => unknown;
  MouseEvent?: new (type: string, init?: unknown) => unknown;
  WheelEvent?: new (type: string, init?: unknown) => unknown;
  KeyboardEvent?: new (type: string, init?: unknown) => unknown;
  PointerEvent?: new (type: string, init?: unknown) => unknown;
  InputEvent?: new (type: string, init?: unknown) => unknown;
  HTMLInputElement?: { prototype: object };
  HTMLTextAreaElement?: { prototype: object };
  Touch?: new (init: unknown) => unknown;
  location?: { assign?(url: string): void };
  open?(url: string, target?: string, features?: string): void;
  TouchEvent?: new (type: string, init?: unknown) => unknown;
  Navigator?: { prototype: object };
  Error: new () => { stack?: string };
  console?: Record<string, (...args: unknown[]) => unknown>;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  MutationObserver?: new (callback: () => void) => { observe(target: DomNode, options: { attributes: boolean; attributeFilter: string[] }): void };
  chrome?: { runtime?: { id?: string; sendMessage?(message: unknown): void } };
  __qzInvoke?: (this: unknown, node: DomNode, payload: unknown) => unknown;
  __qzExtensionInputEvents?: { add(value: object): void };
  __qzFirefoxPage?: {
    next: number; nodes: Map<number, DomNode>; objects: Map<string, { node: DomNode; group: string }>;
    mouseTarget: DomNode | null; touchTarget: DomNode | null;
  };
}
