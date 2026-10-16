const DEFAULT_TAIL_THRESHOLD_PX = 28;
const PROGRAMMATIC_SCROLL_GRACE_MS = 140;
const trackedTailTargets = new WeakSet<HTMLElement>();
const programmaticScrollUntilByTarget = new WeakMap<HTMLElement, number>();

// Capabilities declare scroll surfaces; the framework owns generic transcript containers.
export const INNER_SCROLL_TARGET_SELECTOR = [
  "[data-tool-scroll-surface]",
  ".markdown-code-block > pre",
  ".copyable-code-block > pre",
  ".tool-timeline-slot-body",
  ".thinking-group-body",
].join(", ");

export function installTailTracker(target: HTMLElement | null, { threshold = DEFAULT_TAIL_THRESHOLD_PX } = {}) {
  if (!target || trackedTailTargets.has(target)) return;
  trackedTailTargets.add(target);
  if (!target.dataset.followTail) target.dataset.followTail = "true";
  target.addEventListener("scroll", () => {
    const nearTail = isNearScrollTail(target, threshold);
    if (isProgrammaticScroll(target) && nearTail) return;
    setFollowTail(target, nearTail);
  }, { passive: true });
}

export function shouldFollowTail(target: HTMLElement | null, { threshold = DEFAULT_TAIL_THRESHOLD_PX, defaultFollow = true } = {}) {
  if (!target) return false;
  if (target.dataset.userPinned === "true") return false;
  if (target.dataset.followTail === "false") return false;
  if (target.dataset.followTail === "true") return true;
  return Boolean(defaultFollow && isNearScrollTail(target, threshold));
}

export function setFollowTail(target: HTMLElement | null, following: boolean) {
  if (!target) return;
  target.dataset.followTail = following ? "true" : "false";
  target.dataset.userPinned = following ? "false" : "true";
}

export function scrollToTail(target: HTMLElement | null) {
  if (!target) return;
  markProgrammaticScroll(target);
  setFollowTail(target, true);
  target.scrollTop = target.scrollHeight;
}

export function isNearScrollTail(target: Element | null, threshold = DEFAULT_TAIL_THRESHOLD_PX) {
  if (!target) return true;
  return target.scrollHeight - target.scrollTop - target.clientHeight <= threshold;
}

export function canScrollInDirection(target: Element | null, deltaY: number, threshold = 1) {
  if (!target || Math.abs(Number(deltaY) || 0) <= 0) return false;
  if (!isScrollableY(target)) return false;
  if (deltaY < 0) return target.scrollTop > threshold;
  return target.scrollHeight - target.scrollTop - target.clientHeight > threshold;
}

export function isScrollableY(target: Element | null) {
  if (!target || target.scrollHeight <= target.clientHeight + 1) return false;
  const style = getComputedStyle(target);
  return /(auto|scroll|overlay)/.test(style.overflowY);
}

export function resolveWheelScrollOwner(target: EventTarget | null, deltaY: number, { boundary, innerSelector = INNER_SCROLL_TARGET_SELECTOR }: { boundary?: Element | null; innerSelector?: string } = {}) {
  const start = target instanceof Element ? target : null;
  if (!start || !boundary) return { owner: null, ownerIsInner: false, innerCandidate: null };
  const innerCandidate = start.closest(innerSelector);
  let node: Element | null = start;
  while (node && node instanceof Element) {
    if (canScrollInDirection(node, deltaY)) {
      return {
        owner: node,
        ownerIsInner: Boolean(node.matches?.(innerSelector)),
        innerCandidate,
      };
    }
    if (node === boundary) break;
    node = node.parentElement;
  }
  return { owner: null, ownerIsInner: false, innerCandidate };
}

export function pauseDescendantTailTargets(root: Node | null, { selector = INNER_SCROLL_TARGET_SELECTOR, except = null }: { selector?: string; except?: Element | null } = {}) {
  if (!(root instanceof Element)) return 0;
  let count = 0;
  const targets = root.matches?.(selector)
    ? [root, ...Array.from(root.querySelectorAll?.(selector) || [])]
    : Array.from(root.querySelectorAll?.(selector) || []);
  for (const target of targets) {
    if (!(target instanceof HTMLElement) || target === except || !isScrollableY(target)) continue;
    setFollowTail(target, false);
    count += 1;
  }
  return count;
}

function markProgrammaticScroll(target: HTMLElement) {
  programmaticScrollUntilByTarget.set(target, Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS);
}

function isProgrammaticScroll(target: HTMLElement) {
  return Number(programmaticScrollUntilByTarget.get(target) || 0) > Date.now();
}
