import { SESSION_AUTOMATION_CONTROL_SELECTORS } from "#sdk/shared/session-automations";

/** Remove create, edit, and run controls. Safe to call again after a build already omitted them. */
export function removeSessionAutomationControls(root: ParentNode): void {
  for (const selector of SESSION_AUTOMATION_CONTROL_SELECTORS) {
    root.querySelector(selector)?.remove();
  }
}
