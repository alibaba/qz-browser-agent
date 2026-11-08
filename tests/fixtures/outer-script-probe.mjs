import { readSessionSnapshot } from '../shared/session/session-recovery.js';
import { renderToolEvent, disposeRendererTree } from '../sidepanel/tools/tool-renderer.js';

// Loaded only by the copied Firefox acceptance package, in its actual sidebar realm.
globalThis.__qzOuterScriptEvents=[];
globalThis.__qzOuterScriptTabs=[];
const connect=chrome.runtime.connect.bind(chrome.runtime);
chrome.runtime.connect=(...args)=>{
  const port=connect(...args);
  if(port.name==='sidepanel')port.onMessage.addListener(event=>{
    if(event.type==='tool_execution_end')globalThis.__qzOuterScriptEvents.push(event);
  });
  return port;
};
function observe() {
  globalThis.__qzOuterScriptEvents=[];
  globalThis.__qzOuterScriptTabs=[];
}
globalThis.__qzOuterScriptModules = { readSessionSnapshot, observe, renderToolEvent, disposeRendererTree };
