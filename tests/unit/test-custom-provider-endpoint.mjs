import assert from "node:assert/strict";
import test from "node:test";

import {
  completeCustomProviderEndpoint,
  customProviderModelsEndpoint,
  normalizeCustomProtocol,
  suggestCustomProviderEndpoint,
} from "../../src/shared/models/custom-provider-endpoint.js";

test("completes only known custom endpoint prefixes", () => {
  const cases = [
    ["router.example/v1", "openai", "https://router.example/v1/chat/completions"],
    ["localhost:8080/v1", "anthropic", "http://localhost:8080/v1/messages"],
    ["https://router.example", "openai", "https://router.example/v1/chat/completions"],
    ["https://api.anthropic.com/", "anthropic", "https://api.anthropic.com/v1/messages"],
    ["https://router.example/v1", "openai", "https://router.example/v1/chat/completions"],
    ["https://router.example/proxy/v1/", "anthropic", "https://router.example/proxy/v1/messages"],
    ["https://router.example/v1/messages", "openai", "https://router.example/v1/chat/completions"],
    ["https://router.example/v1/chat/completions", "anthropic", "https://router.example/v1/messages"],
  ];
  cases.forEach(([value, protocol, expected]) => {
    assert.equal(completeCustomProviderEndpoint(value, protocol), expected);
  });
});

test('native and unavailable protocols retain their IDs and endpoint without OpenAI completion', () => {
  assert.equal(normalizeCustomProtocol(' Vendor-Native '), 'vendor-native');
  assert.equal(normalizeCustomProtocol(''), 'openai');
  for (const protocol of ['vendor-native', 'uninstalled-adapter']) {
    assert.equal(suggestCustomProviderEndpoint('https://router.example/v1', protocol), null);
    assert.equal(completeCustomProviderEndpoint('https://router.example/v1', protocol), 'https://router.example/v1');
  }
});

test("leaves complete, invalid and nonstandard endpoints untouched", () => {
  for (const value of [
    "https://router.example/v1/chat/completions",
    "https://router.example/custom/generate",
    "ftp://router.example/v1",
    "not a url",
  ]) {
    assert.equal(completeCustomProviderEndpoint(value, "openai"), value);
  }
  assert.deepEqual(suggestCustomProviderEndpoint("https://router.example/v1", "openai"), {
    value: "https://router.example/v1/chat/completions",
    addition: "/chat/completions",
  });
  assert.deepEqual(suggestCustomProviderEndpoint("asdfasdf.com/v1", "anthropic"), {
    value: "https://asdfasdf.com/v1/messages",
    addition: "/messages",
  });
});


test('model discovery derives only known same-origin sibling routes', () => {
  for (const [endpoint, protocol, expected] of [
    ['http://localhost:3425/v1', 'openai', 'http://localhost:3425/v1/models'],
    ['https://router.example/proxy/v1/chat/completions?api-version=2026', 'openai', 'https://router.example/proxy/v1/models?api-version=2026'],
    ['https://router.example/proxy/v1/messages/', 'anthropic', 'https://router.example/proxy/v1/models'],
    ['https://router.example/custom/generate', 'openai', ''],
    ['https://router.example/v1/models', 'openai', ''],
    ['https://router.example/v1/messages', 'vendor-native', ''],
    ['ftp://router.example/v1/chat/completions', 'openai', ''],
    ['not a url', 'openai', ''],
  ]) assert.equal(customProviderModelsEndpoint(endpoint, protocol), expected);
});
