import assert from "node:assert/strict";
import test from "node:test";
import { createModelOptionsController } from "../../src/capabilities/settings/model-options.js";

function deferredLoader() {
  const requests = [];
  const controller = createModelOptionsController({
    loadModels(input) {
      const pending = Promise.withResolvers();
      requests.push({ input, ...pending });
      return pending.promise;
    },
  });
  return { controller, requests };
}

const ids = result => result.models.map(model => model.id);

for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]]) {
  test(`A → B → A keeps the final request when responses arrive in order ${order.join(", ")}`, async () => {
    const { controller, requests } = deferredLoader();
    const runs = [
      controller.load({ provider: "A", credentialVersion: "a" }),
      controller.load({ provider: "B", credentialVersion: "b" }),
      controller.load({ provider: "A", credentialVersion: "a" }),
    ];
    for (const index of order) requests[index].resolve([{ id: `response-${index}` }]);
    const results = await Promise.all(runs);
    assert.deepEqual(results.map(result => result.stale), [true, true, false]);
    assert.deepEqual(ids(results[2]), ["response-2"]);
    assert.deepEqual(ids(controller.peek({ provider: "A", credentialVersion: "a" })), ["response-2"]);
    assert.equal(controller.peek({ provider: "B", credentialVersion: "b" }), null,
      "a response for a provider no longer selected cannot seed later selections with stale data");
  });
}

for (const outcome of ["success", "failure"]) {
  test(`returning to cached A supersedes in-flight B ${outcome}`, async () => {
    const { controller, requests } = deferredLoader();
    const initial = controller.load({ provider: "A" });
    requests[0].resolve(["saved-model"]);
    await initial;
    const obsolete = controller.load({ provider: "B" });
    const cached = await controller.load({ provider: "A" });
    assert.equal(cached.cached, true);
    assert.deepEqual(ids(cached), ["saved-model"]);
    if (outcome === "success") requests[1].resolve(["late-model"]);
    else requests[1].reject(new Error("stale offline failure"));
    assert.equal((await obsolete).stale, true);
    assert.equal(controller.peek({ provider: "B" }), null);
    assert.deepEqual(ids(controller.peek({ provider: "A" })), ["saved-model"]);
    assert.equal(requests.length, 2, "the cache hit must not start a replacement request");
  });
}

test("failed forced refresh retains prior options and succeeds on explicit retry", async () => {
  const { controller, requests } = deferredLoader();
  const input = { provider: "A", credentialVersion: "account-one" };
  const initial = controller.load(input);
  requests[0].resolve(["original"]);
  await initial;
  const failed = controller.load({ ...input, refresh: true });
  requests[1].reject(new Error("temporarily offline"));
  await assert.rejects(failed, /temporarily offline/);
  assert.deepEqual(ids(await controller.load(input)), ["original"]);
  const retry = controller.load({ ...input, refresh: true });
  requests[2].resolve(["current"]);
  assert.deepEqual(ids(await retry), ["current"]);
  assert.deepEqual(ids(controller.peek(input)), ["current"]);
  assert.equal(requests.length, 3);
});

test("endpoint, account and protocol changes isolate pending responses and cached models", async () => {
  const { controller, requests } = deferredLoader();
  const firstInput = { provider: "custom-service", endpoint: "https://one.example/v1", credentialVersion: "account-one" };
  const secondInput = { ...firstInput, credentialVersion: "account-two" };
  const thirdInput = { ...secondInput, endpoint: "https://two.example/v1" };
  const first = controller.load(firstInput);
  requests[0].resolve(["one-account-one"]);
  await first;
  const second = controller.load(secondInput);
  const third = controller.load(thirdInput);
  requests[2].resolve(["two-account-two"]);
  assert.deepEqual(ids(await third), ["two-account-two"]);
  requests[1].resolve(["one-account-two"]);
  assert.equal((await second).stale, true);
  assert.equal(controller.peek(secondInput), null);
  assert.deepEqual(ids(await controller.load(firstInput)), ["one-account-one"]);
  assert.deepEqual(ids(await controller.load(thirdInput)), ["two-account-two"]);
  const fourthInput = { ...thirdInput, customProtocol: "anthropic" };
  assert.equal(controller.peek(fourthInput), null);
  const fourth = controller.load(fourthInput);
  requests[3].resolve(["anthropic-model"]);
  assert.deepEqual(ids(await fourth), ["anthropic-model"]);
  assert.deepEqual(ids(await controller.load(thirdInput)), ["two-account-two"]);
  assert.equal(requests.length, 4);
});

test("closing and clearing a panel ignores late failure and reopens with a fresh request", async () => {
  const { controller, requests } = deferredLoader();
  const first = controller.load({ provider: "A" });
  controller.cancel();
  controller.invalidate();
  requests[0].reject(new Error("closed panel's failure"));
  assert.equal((await first).stale, true);
  assert.equal(controller.peek({ provider: "A" }), null);
  const reopened = controller.load({ provider: "A" });
  requests[1].resolve(["reopened"]);
  assert.deepEqual(ids(await reopened), ["reopened"]);
  assert.equal(requests.length, 2);
});
