import assert from "node:assert/strict";
import test from "node:test";
import { capabilityTestVariants, prepareCapabilityTestBuilds } from "../support/capability-build-setup.mjs";
import { ensureCapabilityExtension } from "../support/extension-build.mjs";

test("capability fixtures build each graph once and sequentially before publishing worker paths", async () => {
  let active = 0;
  const requests = [];
  const directories = await prepareCapabilityTestBuilds(async options => {
    assert.equal(++active, 1, "compiler jobs must not fan out");
    requests.push(options);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return `/fixture/variant-${requests.length}`;
  });
  assert.deepEqual(requests, capabilityTestVariants);
  assert.equal(Object.keys(directories).length, capabilityTestVariants.length);
  assert.equal(new Set(Object.values(directories)).size, capabilityTestVariants.length);
  const previous = process.env.QINGZHOU_TEST_CAPABILITY_BUILDS;
  try {
    process.env.QINGZHOU_TEST_CAPABILITY_BUILDS = JSON.stringify(directories);
    for (const options of capabilityTestVariants) {
      const key = JSON.stringify({ omitted: options.omit || [], example: options.example === true });
      assert.equal(await ensureCapabilityExtension(options), directories[key]);
      assert.equal(await ensureCapabilityExtension({ ...options, omit: [...(options.omit || []), ...(options.omit || [])] }), directories[key]);
    }
    assert.throws(() => ensureCapabilityExtension({ omit: ["unknown"] }), /not prepared/);
    assert.throws(() => ensureCapabilityExtension({ omit: ["..\/settings"] }), /Invalid capability/);
  } finally {
    if (previous === undefined) delete process.env.QINGZHOU_TEST_CAPABILITY_BUILDS;
    else process.env.QINGZHOU_TEST_CAPABILITY_BUILDS = previous;
  }
});

test("a failed capability build cannot publish a partial catalog or start later builds", async () => {
  const error = new Error("fixture build failed");
  let calls = 0;
  await assert.rejects(prepareCapabilityTestBuilds(async () => {
    if (++calls === 2) throw error;
    return "/fixture/first";
  }), received => received === error);
  assert.equal(calls, 2);
});
