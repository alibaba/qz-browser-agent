const mathJaxConfig = {
  tex: {
    inlineMath: [["$", "$"], ["\\(", "\\)"]],
    displayMath: [["$$", "$$"], ["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true,
    packages: { "[+]": ["ams", "newcommand", "noerrors", "noundefined"] },
    // MathJax 3.2.2 names this command \boldsymbol. \bm is the LaTeX alias.
    macros: {
      bm: ["\\boldsymbol{#1}", 1],
    },
  },
  options: {
    // All TeX/SVG/assistive-MathML code is statically packaged; no component loader or menu.
    skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    ignoreHtmlClass: "tex2jax_ignore",
    processHtmlClass: "math-formula",
  },
  svg: {
    fontCache: "local",
    mtextInheritFont: true,
  },
  startup: {
    typeset: false,
  },
};

(globalThis as typeof globalThis & { MathJax?: typeof mathJaxConfig }).MathJax = mathJaxConfig;
