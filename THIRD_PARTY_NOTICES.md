# Third-party notices

Third-party components are distributed under their own licenses. This document lists dependency
versions, declared licenses, and the license files included with the extension.

## Components distributed with the extension

The root `package.json` and `package-lock.json` pin runtime and development dependencies, including
upstream tarball URLs and integrity hashes. TypeScript imports are bundled with their runtime;
independent PDF and MathJax assets are rebuilt from readable, pinned package inputs. Table CSS is
copied unchanged. The [code audit guide](docs/store-code-audit.md#readable-static-dependencies) documents
the static-only PDF.js and Zod reductions and the MathJax composition. These derivatives are not
represented as byte-identical upstream distributions.

Each build generates `vendor/provenance.json` and `vendor/licenses/` from its actual dependency graph,
including transitive dependencies present in the output. The manifest records package versions,
upstream licenses and integrity, runtime files, and SHA-256 hashes. It ships with the extension.
Run `node scripts/vendor/assets.mjs --check` to check asset generation; see
[dependencies and static resources](docs/commands.md#dependencies-and-static-resources).
MathJax's original mhchem copyright notice is retained. For icons and logos, see
[asset sources](docs/architecture.md#assets).

## npm development dependencies

Source: the root `package-lock.json`, including development tools and platform-specific optional
packages used during development. The generated manifest attributes compiler-inserted runtime
helpers and browser dependencies included in the extension.

| Dependency | Version | Declared license |
| --- | --- | --- |
| @bcoe/v8-coverage | 1.0.2 | MIT |
| @emnapi/core | 1.11.1 | MIT |
| @emnapi/runtime | 1.11.1 | MIT |
| @emnapi/wasi-threads | 1.2.2 | MIT |
| @esbuild/aix-ppc64 | 0.28.1 | MIT |
| @esbuild/android-arm | 0.28.1 | MIT |
| @esbuild/android-arm64 | 0.28.1 | MIT |
| @esbuild/android-x64 | 0.28.1 | MIT |
| @esbuild/darwin-arm64 | 0.28.1 | MIT |
| @esbuild/darwin-x64 | 0.28.1 | MIT |
| @esbuild/freebsd-arm64 | 0.28.1 | MIT |
| @esbuild/freebsd-x64 | 0.28.1 | MIT |
| @esbuild/linux-arm | 0.28.1 | MIT |
| @esbuild/linux-arm64 | 0.28.1 | MIT |
| @esbuild/linux-ia32 | 0.28.1 | MIT |
| @esbuild/linux-loong64 | 0.28.1 | MIT |
| @esbuild/linux-mips64el | 0.28.1 | MIT |
| @esbuild/linux-ppc64 | 0.28.1 | MIT |
| @esbuild/linux-riscv64 | 0.28.1 | MIT |
| @esbuild/linux-s390x | 0.28.1 | MIT |
| @esbuild/linux-x64 | 0.28.1 | MIT |
| @esbuild/netbsd-arm64 | 0.28.1 | MIT |
| @esbuild/netbsd-x64 | 0.28.1 | MIT |
| @esbuild/openbsd-arm64 | 0.28.1 | MIT |
| @esbuild/openbsd-x64 | 0.28.1 | MIT |
| @esbuild/openharmony-arm64 | 0.28.1 | MIT |
| @esbuild/sunos-x64 | 0.28.1 | MIT |
| @esbuild/win32-arm64 | 0.28.1 | MIT |
| @esbuild/win32-ia32 | 0.28.1 | MIT |
| @esbuild/win32-x64 | 0.28.1 | MIT |
| @istanbuljs/schema | 0.1.6 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/source-map | 0.3.11 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @napi-rs/wasm-runtime | 1.1.4 | MIT |
| @playwright/test | 1.61.1 | Apache-2.0 |
| @tailwindcss/oxide | 4.3.3 | MIT |
| @tailwindcss/oxide-android-arm64 | 4.3.3 | MIT |
| @tailwindcss/oxide-darwin-arm64 | 4.3.3 | MIT |
| @tailwindcss/oxide-darwin-x64 | 4.3.3 | MIT |
| @tailwindcss/oxide-freebsd-x64 | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-arm-gnueabihf | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-arm64-gnu | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-arm64-musl | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-x64-gnu | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-x64-musl | 4.3.3 | MIT |
| @tailwindcss/oxide-wasm32-wasi | 4.3.3 | MIT |
| @tailwindcss/oxide-win32-arm64-msvc | 4.3.3 | MIT |
| @tailwindcss/oxide-win32-x64-msvc | 4.3.3 | MIT |
| @tybys/wasm-util | 0.10.2 | MIT |
| @types/chrome | 0.3.0 | MIT |
| @types/filesystem | 0.0.36 | MIT |
| @types/filewriter | 0.0.33 | MIT |
| @types/har-format | 1.2.16 | MIT |
| @types/istanbul-lib-coverage | 2.0.6 | MIT |
| @types/js-yaml | 4.0.9 | MIT |
| @types/tabulator-tables | 6.3.6 | MIT |
| @types/turndown | 5.0.6 | MIT |
| @typescript/typescript-aix-ppc64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-darwin-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-darwin-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-freebsd-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-freebsd-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-arm | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-loong64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-mips64el | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-ppc64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-riscv64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-s390x | 7.0.2 | Apache-2.0 |
| @typescript/typescript-linux-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-netbsd-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-netbsd-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-openbsd-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-openbsd-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-sunos-x64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-win32-arm64 | 7.0.2 | Apache-2.0 |
| @typescript/typescript-win32-x64 | 7.0.2 | Apache-2.0 |
| acorn | 8.18.0 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-styles | 4.3.0 | MIT |
| balanced-match | 4.0.4 | MIT |
| brace-expansion | 5.0.12 | MIT |
| buffer-from | 1.1.2 | MIT |
| c8 | 11.0.0 | ISC |
| cliui | 8.0.1 | ISC |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| commander | 2.20.3 | MIT |
| convert-source-map | 2.0.0 | MIT |
| css-tree | 3.2.1 | MIT |
| emoji-regex | 8.0.0 | MIT |
| enhanced-resolve | 5.25.1 | MIT |
| esbuild | 0.28.1 | MIT |
| escalade | 3.2.0 | MIT |
| find-up | 5.0.0 | MIT |
| foreground-child | 3.3.1 | ISC |
| fsevents | 2.3.2 | MIT |
| fsevents | 2.3.3 | MIT |
| get-caller-file | 2.0.5 | ISC |
| glob | 13.0.6 | BlueOak-1.0.0 |
| graceful-fs | 4.2.11 | ISC |
| has-flag | 4.0.0 | MIT |
| html-escaper | 2.0.2 | MIT |
| is-fullwidth-code-point | 3.0.0 | MIT |
| istanbul-lib-coverage | 3.2.2 | BSD-3-Clause |
| istanbul-lib-report | 3.0.1 | BSD-3-Clause |
| istanbul-reports | 3.2.0 | BSD-3-Clause |
| locate-path | 6.0.0 | MIT |
| lru-cache | 11.5.2 | BlueOak-1.0.0 |
| make-dir | 4.0.0 | MIT |
| mdn-data | 2.27.1 | CC0-1.0 |
| minimatch | 10.2.5 | BlueOak-1.0.0 |
| minipass | 7.1.3 | BlueOak-1.0.0 |
| nanoid | 3.3.19 | MIT |
| p-limit | 3.1.0 | MIT |
| p-locate | 5.0.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-scurry | 2.0.2 | BlueOak-1.0.0 |
| picocolors | 1.1.1 | ISC |
| playwright | 1.61.1 | Apache-2.0 |
| playwright-core | 1.61.1 | Apache-2.0 |
| postcss | 8.5.28 | MIT |
| require-directory | 2.1.1 | MIT |
| semver | 7.8.5 | ISC |
| signal-exit | 4.1.0 | ISC |
| storecheck | 0.1.0 | MIT |
| fflate | 0.8.3 | MIT |
| yaml | 2.9.1 | ISC |
| zod (storecheck only) | 3.25.76 | MIT |
| source-map | 0.6.1 | BSD-3-Clause |
| source-map-js | 1.2.2 | BSD-3-Clause |
| source-map-support | 0.5.21 | MIT |
| string-width | 4.2.3 | MIT |
| strip-ansi | 6.0.1 | MIT |
| supports-color | 7.2.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| tapable | 2.3.3 | MIT |
| terser | 5.43.1 | BSD-2-Clause |
| test-exclude | 8.0.0 | ISC |
| tslib | 2.8.1 | 0BSD |
| tsx | 4.23.13 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| v8-to-istanbul | 9.3.0 | ISC |
| wrap-ansi | 7.0.0 | MIT |
| y18n | 5.0.8 | ISC |
| yargs | 17.7.3 | MIT |
| yargs-parser | 21.1.1 | ISC |
| yocto-queue | 0.1.0 | MIT |

## Locked Python dependencies

Source: the MCP bridge and Python test environment `uv.lock` files. Licenses come from PyPI metadata
for each locked version. This includes branches for different Python versions and platforms;
these service and test dependencies are not bundled in the browser extension.

| Dependency | Version | Declared license |
| --- | --- | --- |
| [annotated-types](https://pypi.org/pypi/annotated-types/0.7.0/json) | 0.7.0 | MIT License |
| [anyio](https://pypi.org/pypi/anyio/4.14.2/json) | 4.14.2 | MIT |
| [attrs](https://pypi.org/pypi/attrs/26.1.0/json) | 26.1.0 | MIT |
| [backports-asyncio-runner](https://pypi.org/pypi/backports-asyncio-runner/1.2.0/json) | 1.2.0 | PSF-2.0 |
| [certifi](https://pypi.org/pypi/certifi/2026.6.17/json) | 2026.6.17 | MPL-2.0 |
| [cffi](https://pypi.org/pypi/cffi/2.0.0/json) | 2.0.0 | MIT |
| [click](https://pypi.org/pypi/click/8.4.2/json) | 8.4.2 | BSD-3-Clause |
| [colorama](https://pypi.org/pypi/colorama/0.4.6/json) | 0.4.6 | BSD License |
| [cryptography](https://pypi.org/pypi/cryptography/50.0.1/json) | 50.0.1 | Apache-2.0 OR BSD-3-Clause |
| [exceptiongroup](https://pypi.org/pypi/exceptiongroup/1.3.1/json) | 1.3.1 | MIT License |
| [greenlet](https://pypi.org/pypi/greenlet/3.5.3/json) | 3.5.3 | MIT AND PSF-2.0 |
| [h11](https://pypi.org/pypi/h11/0.16.0/json) | 0.16.0 | MIT |
| [httpcore](https://pypi.org/pypi/httpcore/1.0.9/json) | 1.0.9 | BSD-3-Clause |
| [httpx](https://pypi.org/pypi/httpx/0.28.1/json) | 0.28.1 | BSD-3-Clause |
| [httpx-sse](https://pypi.org/pypi/httpx-sse/0.4.3/json) | 0.4.3 | MIT |
| [idna](https://pypi.org/pypi/idna/3.18/json) | 3.18 | BSD-3-Clause |
| [iniconfig](https://pypi.org/pypi/iniconfig/2.3.0/json) | 2.3.0 | MIT |
| [jsonschema](https://pypi.org/pypi/jsonschema/4.26.0/json) | 4.26.0 | MIT |
| [jsonschema-specifications](https://pypi.org/pypi/jsonschema-specifications/2025.9.1/json) | 2025.9.1 | MIT |
| [mcp](https://pypi.org/pypi/mcp/1.28.1/json) | 1.28.1 | MIT |
| [packaging](https://pypi.org/pypi/packaging/26.2/json) | 26.2 | Apache-2.0 OR BSD-2-Clause |
| [playwright](https://pypi.org/pypi/playwright/1.61.0/json) | 1.61.0 | Apache-2.0 |
| [pluggy](https://pypi.org/pypi/pluggy/1.6.0/json) | 1.6.0 | MIT |
| [pycparser](https://pypi.org/pypi/pycparser/3.0/json) | 3.0 | BSD-3-Clause |
| [pydantic](https://pypi.org/pypi/pydantic/2.13.4/json) | 2.13.4 | MIT |
| [pydantic-core](https://pypi.org/pypi/pydantic-core/2.46.4/json) | 2.46.4 | MIT |
| [pydantic-settings](https://pypi.org/pypi/pydantic-settings/2.14.2/json) | 2.14.2 | MIT |
| [pyee](https://pypi.org/pypi/pyee/13.0.1/json) | 13.0.1 | MIT |
| [pygments](https://pypi.org/pypi/pygments/2.20.0/json) | 2.20.0 | BSD-2-Clause |
| [pyjwt](https://pypi.org/pypi/pyjwt/2.15.1/json) | 2.15.1 | MIT |
| [pytest](https://pypi.org/pypi/pytest/9.1.1/json) | 9.1.1 | MIT |
| [pytest-asyncio](https://pypi.org/pypi/pytest-asyncio/1.4.0/json) | 1.4.0 | Apache-2.0 |
| [python-dotenv](https://pypi.org/pypi/python-dotenv/1.2.2/json) | 1.2.2 | BSD-3-Clause |
| [python-multipart](https://pypi.org/pypi/python-multipart/0.0.32/json) | 0.0.32 | Apache-2.0 |
| [pywin32](https://pypi.org/pypi/pywin32/312/json) | 312 | PSF |
| [referencing](https://pypi.org/pypi/referencing/0.37.0/json) | 0.37.0 | MIT |
| [rpds-py](https://pypi.org/pypi/rpds-py/0.30.0/json) | 0.30.0 | MIT |
| [rpds-py](https://pypi.org/pypi/rpds-py/2026.5.1/json) | 2026.5.1 | MIT |
| [sse-starlette](https://pypi.org/pypi/sse-starlette/3.4.5/json) | 3.4.5 | BSD-3-Clause |
| [starlette](https://pypi.org/pypi/starlette/1.3.1/json) | 1.3.1 | BSD-3-Clause |
| [tomli](https://pypi.org/pypi/tomli/2.4.1/json) | 2.4.1 | MIT |
| [typing-extensions](https://pypi.org/pypi/typing-extensions/4.15.0/json) | 4.15.0 | PSF-2.0 |
| [typing-extensions](https://pypi.org/pypi/typing-extensions/4.16.0/json) | 4.16.0 | PSF-2.0 |
| [typing-inspection](https://pypi.org/pypi/typing-inspection/0.4.2/json) | 0.4.2 | MIT |
| [uvicorn](https://pypi.org/pypi/uvicorn/0.49.0/json) | 0.49.0 | BSD-3-Clause |

## Documentation media

The README screenshots include Wikipedia content and Wikimedia photographs. Sources, authors,
licenses, and editing details are listed in [media credits](docs/images/credits.md).

## Distribution notes

`certifi` is an MCP bridge transitive dependency licensed under MPL-2.0; retain its license.
Third-party components retain their original copyright and license notices.
