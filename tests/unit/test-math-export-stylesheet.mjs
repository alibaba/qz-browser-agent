import assert from "node:assert/strict";
import test from "node:test";
import { adaptMathSvgStylesheet } from "../../src/sidepanel/features/chat/math-runtime.ts";

test("exported math rules target formula elements instead of mjx-container", () => {
  const css = [
    'mjx-container[jax="SVG"] > svg { overflow: visible; }',
    'mjx-container[jax="SVG"] > svg a { fill: blue; }',
    "mjx-container[jax='SVG'] path[data-c] { stroke-width: 3; }",
    'g[data-mml-node="merror"] > rect[data-background] { fill: yellow; stroke: none; }',
    'g[data-mml-node="mtable"] > line[data-line] { stroke-width: 70px; }',
    "before</style><script>",
  ].join("\n");
  const adapted = adaptMathSvgStylesheet(css);
  assert.equal(adapted.includes("mjx-container"), false);
  assert.match(adapted, /\.math-formula > svg \{ overflow: visible; \}/);
  assert.match(adapted, /\.math-formula > svg a \{ fill: blue; \}/);
  assert.match(adapted, /\.math-formula path\[data-c\] \{ stroke-width: 3; \}/);
  assert.match(adapted, /fill: yellow/);
  assert.match(adapted, /stroke-width: 70px/);
  assert.match(adapted, /before<\\\/style><script>/);
});
