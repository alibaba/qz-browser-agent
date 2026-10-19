import { testPortClient, testPortDisconnect, testPortPostFailure, testPortQueuedTimeout, testPortStaleResponse, testPortStopBoundary } from "./port-cases.mjs";
import { testSessionState, testSessionCausality, testPendingRunLifecycle, testSessionReducerGates, testRuntimeProjection, testEventRouterCausality, testSessionNavigationSingleReveal, testStableSessionOrdering } from "./session-cases.mjs";
import { testDataGridLifecycle, testDataSortProfiles, testDataFilterModel, testDelimitedImport, testJsonImportAndHelpers } from "./data-cases.mjs";
import { testSkillDraft, testSkillSaveIsolation, testModelRequestIsolation, testModelCacheContracts } from "./settings-cases.mjs";
import { testToolPresentationState, testToolPresentationFallbacks, testToolMetadataRegistry, testStaticDomContract, testSessionExportFeature } from "./rendering-cases.mjs";

const tests = [
  ["PortClient orders queued sends and resolves requests", testPortClient],
  ["PortClient rejects in-flight requests on disconnect", testPortDisconnect],
  ["PortClient retires a failed port without replaying the attempted message", testPortPostFailure],
  ["PortClient expires unsent requests without leaking queue state", testPortQueuedTimeout],
  ["PortClient ignores stale responses after reconnect", testPortStaleResponse],
  ["PortClient stop rejects queued and in-flight work exactly once", testPortStopBoundary],
  ["SessionState owns runtime, transcript, record and artifact revisions", testSessionState],
  ["SessionState rejects stale runs and duplicate event sequences", testSessionCausality],
  ["SessionState tracks initialization failure, cancellation and recovery across runs", testPendingRunLifecycle],
  ["SessionState reducer gates isolate runtime, transcript, record and artifacts", testSessionReducerGates],
  ["SessionState projects live runtime details without parallel state", testRuntimeProjection],
  ["Event router applies accepted events once and isolates background UI", testEventRouterCausality],
  ["Session navigation reveals an uncached transcript with one render", testSessionNavigationSingleReveal],
  ["Data grid lifecycle invalidates callbacks from older generations", testDataGridLifecycle],
  ["Data sort profiles infer and compare common units", testDataSortProfiles],
  ["Data filter model composes text, categorical and faceted options", testDataFilterModel],
  ["Data import parser handles BOM, quotes, embedded lines and TSV", testDelimitedImport],
  ["Data import parser handles JSON and file helper contracts", testJsonImportAndHelpers],
  ["SkillDraft keeps one revisioned structured/source authority", testSkillDraft],
  ["Skill save snapshots preserve edits and editor navigation", testSkillSaveIsolation],
  ["Model options controller rejects stale async responses", testModelRequestIsolation],
  ["Model options cache is credential-scoped, bounded and cancellable", testModelCacheContracts],
  ["Tool presentation state survives aggregation, collapse and rebuild", testToolPresentationState],
  ["Tool presentation state falls back by first tool, running tool and latest tool", testToolPresentationFallbacks],
  ["Session sibling order defers movement without losing membership", testStableSessionOrdering],
  ["Tool metadata enriches plugin identity through one registry", testToolMetadataRegistry],
  ["Static DOM ids are unique and direct selectors resolve", testStaticDomContract],
  ["Session Export owns document generation and in-flight UI state", testSessionExportFeature],
];

let failures = 0;
for (const [name, test] of tests) {
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
  }
}

if (failures) {
  console.error(`\n${failures}/${tests.length} sidepanel tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} sidepanel tests passed`);
}
