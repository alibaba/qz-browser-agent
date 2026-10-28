#!/usr/bin/env node
import { resolve } from "node:path";
import { assertNoRemoteCode } from "./check-no-remote-code.mjs";
import { assertReviewableCode } from "./check-reviewable-code.mjs";
import { checkStore } from "./check-store.mjs";

const directory = resolve(process.argv[2] || "dist/extension");
await assertNoRemoteCode([directory]);
const audit = await assertReviewableCode(directory);
const store = await checkStore(directory);
console.log(JSON.stringify({ directory, scripts: audit.length, storecheck: store }, null, 2));
if (!store.ok) process.exitCode = 1;
