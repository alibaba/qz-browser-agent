# Add or change a model provider

Add providers through capability contributions. Choose the smallest extension that fits the service:

| Change | Where to start |
| --- | --- |
| A service using an existing protocol | Contribute a `presets` mapping; ordinary public services come from the [models directory](../src/capabilities/models/models-dev-presets.ts). |
| Extra behavior for an existing service | Contribute an explicit `override: true` preset, as in [provider policies](../src/capabilities/provider-policies/presets.ts). |
| A new request or streaming protocol | Implement a `ProviderAdapter` and contribute a `providers` mapping. |

Use the [provider SDK](../src/sdk/background/providers.ts) for the current contracts and fields.
Keep adapters inside their capability and declare contributions with static exports in its
`index.ts`:

```ts
export { default as providers } from "./providers.js";
export { default as presets } from "./presets.js";
```

Export the contributions the package needs; the build discovers them automatically. See the
[deterministic adapter](../tests/fixtures/capabilities/example/deterministic-provider.ts) and its
[registration](../tests/fixtures/capabilities/example/providers.ts) for an example that works
offline.

## Add a service or adjust its policy

First check whether the locked `@opencode-ai/models/snapshot` already describes the service. The
models capability accepts fixed HTTPS routes, one API key, and supported OpenAI-compatible,
OpenRouter or Anthropic protocols with text and tool calling. Special authentication, template URLs,
Responses endpoints and incompatible per-model routing require a dedicated contribution.

For an existing service, override only the fields you need. A request header or default reasoning
parameter can retain the directory model list and discovery implementation. Registration rejects
missing targets, duplicate definitions, and competing overrides.

Preserve saved service IDs and their credential destinations. The [alias
mapping](../src/capabilities/models/model-capabilities.ts) keeps `bailian` associated with
`alibaba-cn`, and historical `moonshotai` with the domestic service. Directory refreshes may update
model metadata while preserving saved IDs, credential destinations, and protocols.

The build derives a small service routing index from the locked snapshot and packages the full
model directory as `vendor/models-dev/providers.json`. Startup loads the index. Model discovery and
capability matching load the local directory asynchronously; Settings displays its existing loading
state. Concurrent callers share one load. Closing a panel cancels its wait while the shared load
continues. Failed loads can be retried.

Background caches the directory for its lifetime. Reopening the panel reuses that cache. After a
Service Worker restart, the next request reads the packaged file again. Runs await any required local
metadata before resolving their output limits. Known models work offline; only unknown metadata
needs the bounded online refresh.

Keep configuration usable offline. Read known capabilities from the local snapshot or cache first.
Complete unknown capabilities through the provider's discovery implementation. Sending a message
uses saved configuration. Save validates those settings locally. Unknown context windows require
explicit configuration; unknown image support is treated as unavailable.

Service labels and authentication hints may use getters to resolve the current language when a
summary is read. Keep model IDs, user names and parameter values unchanged. Declare menu grouping in
the preset; settings renders the shared catalog. See [localization](localization.md).

## Implement authentication or a protocol

Authentication and discovery callbacks come from trusted build-time presets. Treat settings and
network responses as data. Pass cancellation through validation, login, and discovery; check it
again before saving. Use the supplied discovery readers, normalizers, and timeouts.

[Codex](../src/capabilities/provider-codex/index.ts) is a complete provider: it owns its Responses
adapter, OAuth device login, endpoints, model discovery, and capability declarations. Keep its
[authentication](../src/capabilities/provider-codex/auth.ts) generation barriers: logout,
cancellation or a new login must prevent old exchanges and refreshes from restoring credentials.
Preserve existing storage and option keys when changing the flow.

Its [model discovery](../src/capabilities/provider-codex/models.ts) uses the account's successful
directory and falls back to packaged models on failure or an empty filtered list. Cancellation still
propagates. Use its own [model
capabilities](../src/capabilities/provider-codex/model-capabilities.ts) and [option
declarations](../src/capabilities/provider-codex/options.ts) for account-specific behavior.

An adapter translates requests, messages, tool calls, usage and terminal stream events. Preserve
tool-call identity, event order and `AbortSignal` across every asynchronous boundary. Read the
resolved definition and headers supplied with the request.

## Keep failures and retries in the owning layer

The [gateway](../src/background/llm/index.ts) combines provider defaults, validated user parameters
and the request structure. It owns messages, model identity, tools, stream mode, session identity,
and shared request scheduling. The Agent owns conversation history.

[Transport](../src/background/llm/transport.ts) handles fetch, timeouts, cancellation and SSE byte
framing. It retries recoverable failures while opening a request. The adapter interprets JSON,
provider error envelopes and end markers, including errors embedded in content, then reports stable
failure codes and details for the UI.

OpenAI-compatible requests omit optional output-token limits unless configured in model parameters
or an explicit provider policy. This lets the service choose its default and avoids imposing
`max_tokens` on models that accept only `max_completion_tokens`. Anthropic requests still supply
their required `max_tokens` field.

Compaction reserves the greater of 16,000 tokens and the output limit sent by the adapter. The run
profile captures that limit from the same configuration as the request; an omitted limit retains
the 16,000-token reserve. Compaction planning, send admission, and context usage share this budget.

The Agent owns the bounded recovery budget, compaction and rollback of partial messages. A recovery
request uses this budget with transport retries disabled. The [rate
governor](../src/background/llm/provider-rate-governor.ts) shares queues and cooldowns across
sessions using the same provider credentials. Capacity learning uses explicit codes, status, and
headers. Completed results are delivered independently of learning-state persistence. Raw
request/stream capture requires the explicit diagnostic capability; ordinary lifecycle events carry
identity and phase metadata only.

## Check the change

Start with the relevant subset, then run contracts and the wider checks in the [command
guide](commands.md):

```bash
npm run typecheck
npm test -- unit --match provider
npm test -- unit --match models-dev
npm test -- unit --match llm
npm test -- contracts
npm test -- playwright models-dev-offline.spec.mjs settings-provider-auth.spec.mjs
```

Cover offline discovery, saved aliases and credential routes, unknown models, malformed streams,
tool-call IDs, usage, cancellation and partial output. For authentication, include logout during a
refresh, failed polling and empty model lists. Use deterministic fixtures first; live-provider tests
need an explicit invocation and isolated credentials as described in the command guide.
