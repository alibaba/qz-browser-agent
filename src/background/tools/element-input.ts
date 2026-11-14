import { ToolExecutionError } from "./arguments.js";
import { validateElementLocator } from "../../shared/contracts/element-locator.js";

/** Element tools take one target string or one locator; nth selects among css: target matches only. */
export function validateElementInput(input: Record<string, unknown>, { required = true }: { required?: boolean } = {}): undefined {
  const located = input.locator !== undefined, targeted = input.target !== undefined;
  if (located && targeted || required && !located && !targeted) {
    throw new ToolExecutionError("INVALID_ELEMENT_TARGET", required ? "Pass exactly one of target or locator." : "Pass target or locator, not both.");
  }
  if (!located) return;
  if (input.nth !== undefined) throw new ToolExecutionError("INVALID_ELEMENT_TARGET", "Use locator.nth instead of nth with a locator.");
  try { validateElementLocator(input.locator); }
  catch (error) { throw new ToolExecutionError("INVALID_ELEMENT_LOCATOR", error instanceof Error ? error.message : String(error)); }
}
