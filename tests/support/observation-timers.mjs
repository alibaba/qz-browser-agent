import { syncBuiltinESMExports } from "node:module";

export function mockObservationTimers(t, options) {
  t.mock.timers.enable(options);
  const clear = globalThis.clearTimeout;
  // Early Node 22 MockTimers throws on null/undefined; native clearTimeout is a no-op.
  globalThis.clearTimeout = timer => {
    if (timer != null) clear(timer);
  };
  syncBuiltinESMExports();
  t.after(() => { globalThis.clearTimeout = clear; t.mock.timers.reset(); syncBuiltinESMExports(); });
}
