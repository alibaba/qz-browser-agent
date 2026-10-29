# Contributing to qz

Bug fixes, examples, translations, and documentation improvements are welcome. Open an issue to
discuss a new API or a large change; small fixes can go straight to a pull request.

## Report a bug

Include the qz version or commit, Chrome version, reproduction steps, and expected and actual
results. A small example page or screenshot helps. Remove credentials, private URLs, and personal
data from shared evidence.

## Set up development

Follow the [quick start](README.md#quick-start) and [test setup](docs/commands.md#run-tests). Run
`npm run dev` during development, then reload the extension and reopen the side panel after a
rebuild. Use separate output directories when running a watcher and a production build at the same
time.

Read [AGENTS.md](AGENTS.md) and the guide for the area you are changing. The [architecture
guide](docs/architecture.md) identifies runtime and state owners; the [capability
guide](src/capabilities/README.md) explains tools and other extension points.

Run focused checks while developing:

```bash
npm test -- unit --match session
npm test -- playwright renderer-lifecycle.spec.mjs --workers 1
```

Choose tests for your change using the [test guide](tests/README.md) and the tiers in
[commands](docs/commands.md). Small changes such as copy, thresholds, and documentation run no test
suites. Ordinary changes run typecheck plus the focused checks. Run `npm run verify` for broad
shared-contract changes, and `npm run verify:chrome` or `npm run verify:firefox` only for risky
changes specific to that package. Packaging and releases run `npm run verify:coverage`. Live-provider tests require an explicit invocation and can incur
charges; see [live-test setup](tests/README.md#real-model-tests).

## Extension contracts

Start with the [example package](tests/fixtures/capabilities/example/README.md). Copy the
contributions you need into `src/capabilities/<name>/` and give their registrations unique IDs. The
build discovers `index.ts` automatically. Import framework services through `#sdk/*` and keep
implementation, UI, and resources in the package. Installed Skills use the restricted Skill
execution interfaces.

`npm run docs` generates the API reference at `dist/docs/api.md`. Keep generated output under
`dist/`. The capability APIs are experimental. Preserve saved IDs and user data through upgrades,
normalize historical results at boundaries, and add compatibility tests when formats change.

## Send a pull request

Keep each change focused. Explain the problem, resulting behavior, and checks you ran. Include light
and dark screenshots for UI changes and a regression test for a bug fix. Update the owning guide
when usage or responsibilities change; use direct instructions and link to existing explanations.

Limit formatting and dependency changes to those required by the task. Retain licenses for added
code and assets. Review and test all contributed code, including code produced with an AI assistant.
Contributions use the project's [Apache-2.0 license](LICENSE).
