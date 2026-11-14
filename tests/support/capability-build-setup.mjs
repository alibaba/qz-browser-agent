import { ensureCapabilityExtension } from "./extension-build.mjs";

// Build once in Playwright's coordinator, before browser workers start. Building
// these graphs inside parallel tests duplicates compilers and source copies, and
// leaves other page fixtures competing with compilation for CPU and memory.
export const capabilityTestVariants = [
  { example: true },
  ...["i18n", "settings", "data", "skills"].map(name => ({ omit: [name], example: true })),
  ...["settings", "skills", "mcp", "script", "accessibility", "ui", "media"].map(name => ({ omit: [name] })),
];

export async function prepareCapabilityTestBuilds(buildVariant = ensureCapabilityExtension) {
  const directories = {};
  for (const options of capabilityTestVariants) {
    const key = JSON.stringify({ omitted: options.omit || [], example: options.example === true });
    directories[key] = await buildVariant(options);
  }
  return directories;
}

export default async function setup() {
  const directories = await prepareCapabilityTestBuilds(async options => {
    const started = performance.now();
    const directory = await ensureCapabilityExtension(options);
    console.log(`Capability fixture ${JSON.stringify(options)} built once in ${Math.round(performance.now() - started)}ms`);
    return directory;
  });
  process.env.QINGZHOU_TEST_CAPABILITY_BUILDS = JSON.stringify(directories);
}
