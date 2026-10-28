import { expect, test as base } from "@playwright/test";
import { openFirefoxSidebar } from "./launch.mjs";

export const test = base.extend({
  firefoxSidebar: [async ({}, use) => {
    const session = await openFirefoxSidebar();
    await use(session);
    await session.close();
  }, { scope: "worker" }],
});

export { expect };
