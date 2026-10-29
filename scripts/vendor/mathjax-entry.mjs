// Static MathJax 3.2.2 composition. No webpack runtime, component loader, menu or SRE.
// Use upstream Startup methods so retries, clearing and SVG conversion keep their semantics.
import { MathJax, Startup } from "mathjax-full/ts/components/startup.js";
import { mathjax } from "mathjax-full/ts/mathjax.js";
import { STATE } from "mathjax-full/ts/core/MathItem.js";
import { SerializedMmlVisitor } from "mathjax-full/ts/core/MmlTree/SerializedMmlVisitor.js";
import { browserAdaptor } from "mathjax-full/ts/adaptors/browserAdaptor.js";
import { HTMLHandler } from "mathjax-full/ts/handlers/html/HTMLHandler.js";
import { TeX } from "mathjax-full/ts/input/tex.js";
import { AllPackages } from "mathjax-full/ts/input/tex/AllPackages.js";
import { SVG } from "mathjax-full/ts/output/svg.js";
import { AssistiveMmlHandler } from "mathjax-full/ts/a11y/assistive-mml.js";
import { insert } from "mathjax-full/ts/util/Options.js";
import { Configuration, ConfigurationHandler } from "mathjax-full/ts/input/tex/Configuration.js";
import { CommandMap } from "mathjax-full/ts/input/tex/SymbolMap.js";
import TexError from "mathjax-full/ts/input/tex/TexError.js";

// Preserve \\require for statically registered TeX extensions without importing the URL loader.
const localPackages = new Set([...AllPackages, "physics", "colorv2"]);
for (const restricted of ["base", "configmacros", "tagformat"]) localPackages.delete(restricted);
new CommandMap("qz-local-require", { require: "Require" }, {
  Require(parser, command) {
    const name = parser.GetArgument(command);
    if (!localPackages.has(name)) throw new TexError("BadRequire", 'Extension "%1" is not packaged', name);
    const state = parser.configuration.packageData.get("qz-local-require");
    if (state.required.has(name)) return;
    state.required.add(name);
    const configuration = ConfigurationHandler.get(name);
    state.jax.configuration.add(name, state.jax);
    if (configuration.preprocessors.length) mathjax.retryAfter(Promise.resolve());
  },
});
Configuration.create("qz-local-require", {
  handler: { macro: ["qz-local-require"] },
  config(_configuration, jax) {
    jax.parseOptions.packageData.set("qz-local-require", { jax, required: new Set(jax.options.packages) });
  },
});

MathJax._.mathjax = { mathjax };
MathJax._.core = { MathItem: { STATE }, MmlTree: { SerializedMmlVisitor: { SerializedMmlVisitor } } };
const configuredPackages = MathJax.config.tex?.packages;
MathJax.config.tex ||= {};
MathJax.config.tex.packages = ["qz-local-require", ...AllPackages];
if (configuredPackages) insert(MathJax.config.tex, { packages: configuredPackages });
Startup.registerConstructor("tex", TeX);
Startup.registerConstructor("svg", SVG);
Startup.registerConstructor("browserAdaptor", browserAdaptor);
Startup.registerConstructor("HTMLHandler", HTMLHandler);
Startup.useInput("tex");
Startup.useOutput("svg");
Startup.useAdaptor("browserAdaptor");
Startup.useHandler("HTMLHandler");
Startup.extendHandler(AssistiveMmlHandler);
Startup.defaultReady();
