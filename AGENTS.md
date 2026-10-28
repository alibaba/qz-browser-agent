# Development rules

These rules apply throughout the repository. Capability changes also follow
[src/capabilities/AGENTS.md](src/capabilities/AGENTS.md).

## Start here

| Work on | Guide |
| --- | --- |
| Local setup and commands | [README](README.md), [commands](docs/commands.md) |
| Runtime, storage, or UI state | [Architecture](docs/architecture.md) |
| Tools, renderers, or other extensions | [Capabilities](src/capabilities/README.md) |
| Controls and styles | [Design system](docs/design-system.md) |
| Model connections | [Providers](docs/providers.md) |
| Languages and interface copy | [Localization](docs/localization.md) |
| Tests and performance | [Tests](tests/README.md), [benchmarks](docs/benchmarks.md) |
| Local MCP service | [MCP bridge](services/mcp-bridge/README.md) |
| Firefox and Chrome packages | [Firefox packaging](docs/firefox-packaging.md) |

Use Node.js 24 LTS and locked dependencies installed with `npm ci`. Source lives in `src/`; Chrome
loads the compiled extension from `dist/extension/`.

## Runtime and state

- Background owns task state and persistence. Side Panel owns presentation state. Shared modules
  define storage and communication protocols and depend only on code usable by their consumers.
- Communicate across Background, Side Panel, Content, offscreen, sandbox, and service processes
  through explicit protocols. Side Panel uses its transport and Background API; Content keeps
  runtime state inside the isolated world.
- Keep `service-worker.ts` as the composition root. Implement behavior in focused modules with
  injected dependencies.
- A Session is the task isolation unit. Carry its explicit ID through every state-changing operation.
  `SessionSupervisor` owns live Agents, waits, epochs, active runs, and write authority; repositories
  own persistence.
- Serialize conflicting writes within a Session and preserve concurrency between Sessions. Carry
  `sessionId`, `runId`, event order, epoch, `AbortSignal`, and tool-call identity across async boundaries.
- Stop/delete establishes terminal state or a deletion barrier and revokes old write authority before
  cleanup. Reject late events and writes from obsolete runs. Parent and child Sessions own separate
  runs and tabs; aggregate their data through read-only APIs.
- Page tools target the Session's `workingTabId` or an explicitly owned tab. Require explicit selection
  when a target is unavailable.
- Use the owning Repository/Store API for storage. Version wire and storage formats, normalize old
  records at boundaries, and test migrations. Preserve Data Store optimistic concurrency checks.
- Derive `listSummary` from Session records, transcripts, and resource stores. Parse and serialize
  structured data with structured tools.

## Tools and capabilities

- Register build-time tools with `qz.registerTool(...)` through a capability's `tools` export.
  Execution, safety, and permission hosts live in `src/background/tools/`. Skill tools use the same
  protocols through `background/skills/skill-tool-runtime.ts`.
- Contribute embedded Skills through `skills` and trusted host execution through `skillHosts`.
  Dispatch through validated contributions and bindings. Keep built-in Skill names within their packages.
- Contribute presentation through `metadata`. Use `shared/tools/tool-metadata.ts` and
  `shared/tools/tool-identity.ts` to resolve tool presentation and identity across features.
- Describe a tool's purpose, arguments, and calling method in its description. Put cross-tool policies
  in the system prompt. Prefer flat object schemas with an explicit action when they fit the operation.
- Store large results in files, Data tables, artifacts, or chunk protocols; return concise results and
  stable identifiers. Failures include a stable `code`, a localized explanation, and recovery guidance.
- Use shared safety guards for navigation, fetch, scripts, Skills, and MCP. Scope a user-granted
  exception to the requested target and retain all other checks. Validate URLs and resource paths;
  Skill paths stay within their package.

## Side Panel

- Project Background snapshots and events through `features/sessions/session-state.ts`, then render
  the DOM. Project transcripts before reconciliation and preserve stable keys, selection, focus,
  scroll intent, and user-controlled presentation state.
- Store expansion and active-tool selection in `features/chat/transcript/presentation-state.ts`, keyed
  by stable turn/tool identity. Preserve them through rebuilds and single-tool → timeline → family upgrades.
- Connect features through bounded ports in `features/app/workspace-composition.ts`. Capabilities own
  their UI, templates, styles, and renderers. Cross-package cooperation uses explicit optional contracts.
- Reuse `qz-*` controls, tokens, popovers, and tool profiles in both color schemes. `sidepanel.css`
  assembles the selected theme and module styles; HTML exports embed the active skin.
- Follow the [CSS contract](docs/design-system.md), implemented by `src/themes/default/`. Keep Tailwind's
  `theme → base → vendor → components → utilities` layers and import its utilities with the project theme.
  Use complete static `qz:` class names. A deliberate visual migration, when the task asks for one,
  compares actual old/new DOM with zero pixel difference; ordinary UI and copy changes skip this.

## Source layout

- Group code by runtime and responsibility. Side Panel `ui/` holds shared controls, `capability-host/`
  holds extension hosts, and `features/` holds user flows. Give each module a specific responsibility.
- Keep public types in their SDK modules, cross-runtime protocols in Shared, and private types with
  their implementations. Maintain one owner for each type and import it directly.
- Each capability lives in `src/capabilities/<name>/` with one `index.ts` declaration entry and static
  named exports. The build discovers contributions and validates dependency graphs.
- Keep capability pages, settings, templates, and styles together. Use distinct DOM, command, and
  contribution IDs. During disposal, revoke listeners and asynchronous write authority before cleanup.
- Keep `tsconfig.json` at the root and runtime configurations in `config/typescript/`. Apply each
  runtime's globals to its actual dependency graph.
- Keep application source in `src/`, services in `services/`, maintenance commands in `scripts/`, and
  tests, fixtures, benchmarks, and live-test resources in `tests/`.
- Pin JavaScript dependencies in the root `package.json` and `package-lock.json`; import them explicitly
  in TypeScript. Generate independent browser assets and licenses into build output. Preserve upstream
  bytes, licenses, and source maps when rebuilding third-party assets.
- Keep `dist/`, `tests/results/`, `_metadata/`, caches, virtual environments, and private fixtures ignored.
  Use synthetic fixtures in source control; store real exports in the ignored benchmark sample directory.
- Store local secrets in the ignored root `.env.local`, mode `600`. Keep credential values empty in
  `.env.example` and redact secrets from logs.

## Documentation

- Explain the task, give the command or example, then describe the relevant behavior.
- State what the code does and what the reader should do. Use concrete subjects and verbs, short
  paragraphs, and positive instructions. Remove rhetorical contrasts, promotional language, and repetition.
- Keep setup in the root README, command usage in `docs/commands.md`, implementation details in the
  relevant guide, and capability authoring beside the packages. Link to the owning guide for detail.
- Keep READMEs at reader entry points: the project, independently used packages, copyable examples,
  and local sample directories. Keep reference docs current; remove completed plans and obsolete drafts.
- Write module and contributor guides in English, with `README.zh-CN.md` for Chinese readers.
  Preserve language-specific examples that test localization or show actual input.
- Keep names, commands, examples, and links consistent across guides. Link to SDK types and generated
  API docs for interface signatures. Preserve upstream license text verbatim.

## Development principles

- Concise but not crude: prefer the smallest complete implementation that can be justified.
- Thorough but not verbose: no drive-by refactors, no parallel alternate implementations, and no
  scope creep.
- User experience first: minimize the steps an end user needs to complete a task.

## Workflow

1. Read the relevant guide and check `git status --short` before editing.
2. Trace entry points, state owners, protocols, and tests. Keep relative `.js` imports in TypeScript;
   capabilities access the framework through `#sdk/*`.
3. Make the smallest complete change that preserves these boundaries. Re-read files before editing
   in a shared tree and preserve other contributors' changes.
4. Add tests proportional to risk and type-check TypeScript. When a change alters state,
   concurrency, persistence, or cross-context message behavior, use judgment to add failure and
   recovery tests for that behavior.
5. Verify by tier, as described in [Commands and validation](#commands-and-validation). Small changes
   run no tests; ordinary feature and bug work runs typecheck plus focused tests for the touched
   area. Review the final status and diff.
6. Stage, commit, and push only when the task requires it or the user requests it. Publish or change
   tags only when the user requests it. Use reversible Git operations and preserve unrelated work.
   Author, trailer, and pull-request limits are in [Git and commits](#git-and-commits).

## Git and commits

- Keep AI tools and assistant brands out of the author and committer name and email, including Cursor, Copilot, Claude, and ChatGPT.
- Leave `Co-authored-by` trailers, Cursor signatures, and Cursor trailers out of commits.
- Force-push only when the user explicitly asks.
- Open a pull request only when the user explicitly asks. Pushing the working branch is enough.
- Stage, commit, and push only when the task requires it or the user requests it.

## Commands and validation

[Commands](docs/commands.md) covers setup and selectors; [tests](tests/README.md) covers fixtures
and coverage. Prefer existing suite/scenario selectors. Live-provider tests require an explicit
`npm test -- live <scenario>` invocation, a task requiring real-provider behavior, and effects
isolated from user Sessions.

Choose the verification tier from the size of the change:

- **Small changes** (copy and i18n text, timeouts, thresholds, gates, small fixes, documentation):
  run no test suites. Make the change, run `npm run typecheck` when TypeScript changed and it is
  cheap, then commit and push.
- **Ordinary feature and bug work**: run the fast loop for the touched area and stop there. Do not
  end ordinary or cloud-agent tasks with a full suite run.
  1. `npm run typecheck`
  2. `npm test -- unit --match <area>` for the touched units (`--match firefox` for Firefox adapter work)
  3. `npm test -- playwright <spec files>` for affected browser specs, only when browser behavior
     changed. `--match` filters unit paths or suite command labels when a spec file list is the
     wrong selector.
- **Broad changes**: run `npm run verify` (typecheck, then `unit`, `contracts`, and `services`) only
  when a change touches shared contracts broadly or the task asks for it. Add `npm run verify:chrome`
  (`browser`, `e2e`, `release`, and `visual` on `dist/extension/`) or `npm run verify:firefox` (the
  Firefox package suite) only for risky changes specific to that browser package.
- **Coverage**: run `npm run verify:coverage` (typecheck and `npm test -- --all --coverage`) only
  for releases or when the user explicitly asks. `--all` does not select Firefox.

For a full Chrome browser run, set `QINGZHOU_PLAYWRIGHT_WORKERS` to the available core count
(`$(nproc)` on Linux). The default worker count is `ceil(availableParallelism() / 3)`, capped at 4.
An explicit value is clamped to 1-16.

When a long run is needed, capture its output and exit code on the first run, for example
`npm run verify:chrome > /tmp/verify-chrome.log 2>&1; echo EXIT:$?`, and cite that log instead of
rerunning.

The runner stops at the first failing command. When a known baseline failure would stop the run
before later suites finish, run each unfinished suite on its own (`npm test -- e2e`,
`npm test -- release`, `npm test -- visual`). Skip suites that already passed. Do not repeat a
suite that failed for the same failure.

When a change needs tests, pick the narrowest relevant check from this table. It is a menu, not a
checklist to run in full; small changes skip it.

| Change | Relevant checks |
| --- | --- |
| Shared protocol/storage | Unit + contracts + affected producers and consumers |
| Background Session/Agent/tool runtime | Unit + contracts; E2E for user-visible workflows |
| Side Panel state/rendering | Unit + browser; visual/benchmark for streams, timelines, virtualized Data, motion, or layout |
| Content/page execution | Contracts + browser/E2E on constructed pages |
| Python service | Service pytest suite + endpoint failures |
| CSS | Relevant browser/visual fixtures in both color schemes |
| Packaging/installation | Release suite + local package/loading checks and trace assertions |
| Documentation | Commands, local file and heading links, branch-specific behavior, and executable examples |
| Broad shared-graph change shipped in the Chrome and Firefox packages | `verify`; `verify:firefox` when Firefox behavior is at risk |
| Risky Chrome package behavior loaded from `dist/extension/` | `verify:chrome` |
| Firefox-only adapter, manifest rewrite, or Firefox tests | `npm test -- unit --match firefox`; `verify:firefox` when the Firefox package is at risk |

Test observable behavior. Add failure-path tests, such as cancellation or stale events, only where
the change introduces that risk. Build checks cover fixed entries, deterministic output,
independent assets, obsolete-file cleanup, source maps, and licenses. Side Panel splitting also checks deferred execution and relative resources.

## Versioned packages

Distribution requires explicit authorization for the version and uses committed Git `HEAD`. The
publisher builds a local ZIP from that commit in a temporary directory. `--source worktree` creates
a local preview. Uploading artifacts and creating tags require separate authorization.

Before distribution, confirm the intended commit and a clean working tree. Run `npm ci`, `npm run
doctor`, and `npm run verify:coverage`; inspect the ZIP and load it in an isolated Chrome profile.

Use Chrome-compatible numeric versions. Check the packaged source commit, file counts, sizes,
SHA-256, licenses, and runtime entries. Keep the source manifest unchanged. Published tags and
artifacts are immutable; release fixes under a new patch version.

The complete procedure is in [Package a version](docs/commands.md#package-a-version).
