#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


REPO_DIR = Path(__file__).resolve().parents[1]
DEFAULT_EXTENSION_DIR = REPO_DIR / "src"
DEFAULT_OUTPUT_DIR = REPO_DIR / "dist" / "releases"
DEFAULT_BUILD_SCRIPT = REPO_DIR / "scripts" / "build-extension.mjs"
PACKAGE_ROOT = "qz-browser-agent-extension"
# Keep equal to FIREFOX_GECKO_ID in scripts/firefox-manifest.mjs.
FIREFOX_GECKO_ID = "qz-browser-agent@heleifz.github.io"
FIREFOX_PACKAGE_NAME = "qz-browser-agent-firefox"
FIREFOX_KEPT_PERMISSIONS = ("webNavigation", "webRequest", "webRequestBlocking")
FIREFOX_DATA_COLLECTION_REQUIRED = ("websiteContent", "browsingActivity")
RELEASE_NOTICES = ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md")
SKIP_DIRS = {
    ".git",
    "__pycache__",
    "__MACOSX",
    "_metadata",
}
SKIP_FILENAMES = {
    ".DS_Store",
    "README.md",
    "Thumbs.db",
}


@dataclass(frozen=True)
class ReleasePaths:
    directory: Path
    package: Path
    readme: Path
    version_json: Path
    debug: Path


def main() -> int:
    args = parse_args()
    version = normalize_version(args.version)
    if args.source == "git" and args.prepared_source is None:
        return run_commit_publisher(args)
    source_tmp: tempfile.TemporaryDirectory[str] | None = None
    git_commit = ""
    bundling_summary = {"enabled": False, "entries": [], "inputFiles": 0, "outputFiles": 0}
    minification_summary = {"enabled": False, "files": 0, "tool": ""}
    try:
        if args.source == "git":
            if args.prepared_source.resolve() != REPO_DIR or not re.fullmatch(r"[0-9a-f]{40,64}", args.prepared_commit):
                raise SystemExit("invalid prepared Git release source")
            assert_isolated_prepared_source(args.origin_repo)
            git_commit = args.prepared_commit
            extension_dir = REPO_DIR / "src"
            source_label = f"git {args.git_ref} ({git_commit[:12]})"
        else:
            source_tmp = tempfile.TemporaryDirectory(prefix="qingzhou-release-")
            source_dir = args.extension_dir.resolve()
            extension_dir = copy_extension_worktree(source_dir, Path(source_tmp.name))
            source_label = f"worktree {source_dir}"

        release_notices = read_release_notices()
        manifest = load_manifest(extension_dir)
        source_manifest_version = str(manifest.get("version") or "").strip()
        manifest_version = sync_manifest_version(extension_dir, manifest, version)

        extension_dir, bundling_summary = compile_extension_sources(
            extension_dir,
            bundle=not args.no_bundle,
            browser="firefox" if args.target == "firefox" else "chrome",
        )
        if args.target == "webstore":
            manifest_path = extension_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest.pop("key", None)
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for name, contents in release_notices.items():
            (extension_dir / name).write_bytes(contents)

        # Store reviewers receive the same readable code as local builds. Never mangle or compress.

        output = release_paths(args.output_dir.resolve(), version, args.target)
        output.directory.mkdir(parents=True, exist_ok=True)
        debug_files = collect_debug_files(extension_dir)
        refresh_dependency_provenance(extension_dir, minification_summary)
        files = list(iter_extension_files(extension_dir))
        if not files:
            raise SystemExit(f"no extension files found under {extension_dir}")
        file_count = len(files)
        uncompressed_size = sum(path.stat().st_size for path in files)
        assert_no_remote_code(extension_dir)
        audit_reviewable_code(extension_dir)

        make_package_zip(
            extension_dir,
            files,
            output.package,
            version,
            uncompressed_size=uncompressed_size,
            bundling=bundling_summary,
            target=args.target,
        )
        if args.target == "webstore":
            try:
                validate_webstore_package(output.package)
                # Audit the actual upload bytes, not just the pre-ZIP staging directory.
                with tempfile.TemporaryDirectory(prefix="qingzhou-store-audit-") as audit_tmp:
                    with zipfile.ZipFile(output.package) as archive:
                        archive.extractall(audit_tmp)
                    assert_no_remote_code(Path(audit_tmp))
                    audit = audit_reviewable_code(Path(audit_tmp))
                    (output.directory / "code-audit.json").write_text(audit, encoding="utf-8")
                check_store_package(output.package, output.directory / "storecheck.json")
            except (ValueError, zipfile.BadZipFile, SystemExit):
                output.package.unlink(missing_ok=True)
                raise
        elif args.target == "firefox":
            try:
                validate_firefox_package(output.package)
            except (ValueError, zipfile.BadZipFile):
                output.package.unlink(missing_ok=True)
                raise
        package_sha256 = sha256_file(output.package)
        write_debug_package(output, debug_files, extension_dir, version=version,
                            source=args.source, git_commit=git_commit, package_sha256=package_sha256)
        package_size = output.package.stat().st_size
        readme = build_readme(
            version=version,
            title=args.title,
            summary=args.summary,
            features=args.features,
            notes=args.notes,
        )
        output.readme.write_text(readme, encoding="utf-8")
        output.version_json.write_text(
            json.dumps(
                {
                    "version": version,
                    "manifestVersion": manifest_version,
                    "sourceManifestVersion": source_manifest_version,
                    "package": output.package.name,
                    "readme": output.readme.name,
                    "packageRoot": "." if archive_uses_root_manifest(args.target) else PACKAGE_ROOT,
                    "target": args.target,
                    **({"browser": "firefox", "geckoId": FIREFOX_GECKO_ID} if args.target == "firefox" else {}),
                    "source": args.source,
                    "gitRef": args.git_ref if args.source == "git" else "",
                    "gitCommit": git_commit,
                    "bundling": bundling_summary,
                    "minification": minification_summary,
                    "fileCount": file_count,
                    "uncompressedSize": uncompressed_size,
                    "size": package_size,
                    "sha256": package_sha256,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    finally:
        if source_tmp is not None:
            source_tmp.cleanup()

    print(f"Built {display_path(output.package)}")
    print(f"Built {display_path(output.readme)}")
    print(f"Built {display_path(output.version_json)}")
    print(f"Built {display_path(output.debug)} (local debug files)")
    print(f"Source {source_label}")
    print(f"Packaged {file_count} extension files ({uncompressed_size} uncompressed bytes)")
    if bundling_summary["enabled"]:
        print(
            "Bundled "
            f"{bundling_summary['inputFiles']} modules -> "
            f"{bundling_summary['outputFiles']} runtime bundles with {bundling_summary['tool']}"
        )
    if minification_summary["enabled"]:
        print(f"Minified {minification_summary['files']} JS files with {minification_summary['tool']}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a local qz extension package from an isolated source snapshot.",
    )
    parser.add_argument("--version", required=True, help="Release version, for example 0.1.0.")
    parser.add_argument("--target", choices=["manual", "webstore", "firefox"], default="manual",
                        help="manual keeps the Chrome installation folder; webstore places manifest.json at the ZIP root; firefox writes an unsigned .xpi with manifest.json at the archive root.")
    parser.add_argument(
        "--source",
        choices=["git", "worktree"],
        default="git",
        help="Package source. Git exports source, build scripts and locked dependencies from --git-ref.",
    )
    parser.add_argument("--git-ref", default="HEAD", help="Git ref to package when --source=git.")
    parser.add_argument("--extension-dir", type=Path, default=DEFAULT_EXTENSION_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--title", default="", help="Markdown title. Defaults to qz <version>.")
    parser.add_argument("--summary", default="", help="One-line release summary.")
    parser.add_argument("--feature", dest="features", action="append", default=[], help="Feature bullet. Can repeat.")
    parser.add_argument("--notes", default="", help="Additional markdown appended to README.")
    parser.add_argument("--no-bundle", action="store_true", help="Disable release-only background/sidepanel bundling.")
    parser.add_argument("--no-minify", action="store_true", help="Compatibility flag; all releases are unminified.")
    parser.add_argument("--prepared-package-source", dest="prepared_source", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--prepared-commit", default="", help=argparse.SUPPRESS)
    parser.add_argument("--origin-repo", type=Path, default=REPO_DIR, help=argparse.SUPPRESS)
    return parser.parse_args()


def normalize_version(version: str) -> str:
    value = str(version or "").strip().lstrip("vV")
    components = value.split(".")
    if not 1 <= len(components) <= 4 or any(
        not re.fullmatch(r"0|[1-9][0-9]{0,4}", part) or int(part) > 65535
        for part in components
    ) or not any(int(part) for part in components):
        raise SystemExit("version must contain 1–4 integers from 0 to 65535, without leading zeros, and must not be all zero")
    return value


def load_manifest(extension_dir: Path) -> dict:
    manifest_path = extension_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"{manifest_path} does not exist")
    with manifest_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"{manifest_path} is not a JSON object")
    name = str(data.get("name") or "")
    description = str(data.get("description") or "")
    if name.startswith("__MSG_") or description.startswith("__MSG_"):
        locale = str(data.get("default_locale") or "")
        if not re.fullmatch(r"[A-Za-z]+(?:_[A-Za-z0-9]+)*", locale):
            raise SystemExit(f"{manifest_path} has an invalid default_locale")
        messages_path = extension_dir / "_locales" / locale / "messages.json"
        try:
            messages = json.loads(messages_path.read_text(encoding="utf-8"))
            def localize(value: str) -> str:
                match = re.fullmatch(r"__MSG_([A-Za-z0-9_@]+)__", value)
                return str(messages[match[1]]["message"]) if match else value
            name, description = localize(name), localize(description)
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise SystemExit(f"{manifest_path} has invalid default locale messages: {error}") from error
    brand_text = (name + " " + description).lower()
    # Keep localized and historical names; the short international name must be a whole word.
    known_brand = any(brand in brand_text for brand in ("轻舟", "輕舟", "軽舟", "qingzhou")) or re.search(r"\bqz\b", brand_text)
    if data.get("manifest_version") != 3 or not known_brand:
        raise SystemExit(f"{manifest_path} does not look like the qz extension manifest")
    return data


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_DIR))
    except ValueError:
        return str(path)


def sync_manifest_version(extension_dir: Path, manifest: dict, version: str) -> str:
    previous = str(manifest.get("version") or "").strip()
    if previous == version:
        return version
    manifest["version"] = version
    manifest_path = extension_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if previous:
        print(f"Updated package manifest version {previous} -> {version}")
    else:
        print(f"Set package manifest version -> {version}")
    return version


def resolve_git_commit(git_ref: str) -> str:
    return run_git(["rev-parse", "--verify", f"{git_ref}^{{commit}}"]).strip()


def assert_isolated_prepared_source(origin_repo: Path) -> None:
    # This private re-entry runs only in an exported snapshot. Never let its
    # version rewrites touch a checkout, including a nested worktree path.
    if REPO_DIR == origin_repo.resolve() or (REPO_DIR / ".git").exists():
        raise SystemExit("prepared release source must be an isolated export, not a Git worktree")
    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"], cwd=REPO_DIR,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0 and result.stdout.strip() == "true":
        raise SystemExit("prepared release source must be an isolated export, not a Git worktree")


def run_commit_publisher(args: argparse.Namespace) -> int:
    commit = resolve_git_commit(args.git_ref)
    with tempfile.TemporaryDirectory(prefix="qingzhou-release-") as temporary:
        snapshot = Path(temporary)
        export_release_from_git(commit, snapshot)
        npm = shutil.which("npm")
        if not npm:
            raise SystemExit("release compilation requires npm; install the documented Node toolchain")
        result = subprocess.run(
            [npm, "ci", "--include=dev", "--no-audit", "--no-fund"],
            cwd=snapshot, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if result.returncode:
            raise SystemExit(f"failed to install dependencies from the release commit lockfile: {result.stderr.strip()}")
        # A package-specific re-entry flag makes older publishing scripts reject
        # the invocation before they can perform deployment actions.
        return subprocess.run(
            [sys.executable, str(snapshot / "scripts" / "publish-release.py"), *sys.argv[1:],
             "--output-dir", str(args.output_dir.resolve()),
             "--prepared-package-source", str(snapshot), "--prepared-commit", commit,
             "--origin-repo", str(REPO_DIR)],
            cwd=REPO_DIR,
        ).returncode


def export_release_from_git(git_ref: str, destination: Path) -> None:
    root_files = run_git(["ls-tree", "--name-only", git_ref]).splitlines()
    paths = ["src", "scripts", "config", "package.json", "package-lock.json", "tsconfig.json", *RELEASE_NOTICES]
    if ".nvmrc" in root_files:
        paths.append(".nvmrc")
    required = ["src/manifest.json", "scripts/publish-release.py", "scripts/build-extension.mjs", "scripts/build-extension-bundles.mjs", "scripts/capability-catalog.mjs", "scripts/extension-boundaries.mjs", "package.json", "package-lock.json", "tsconfig.json", "config/typescript", *RELEASE_NOTICES]
    for path in required:
        check = subprocess.run(["git", "cat-file", "-e", f"{git_ref}:{path}"], cwd=REPO_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode:
            raise SystemExit(f"release commit lacks {path}; select a commit containing all required release inputs")
    archive_path = destination / "source.tar"
    with archive_path.open("wb") as f:
        subprocess.run(
            ["git", "archive", "--format=tar", git_ref, *paths],
            cwd=REPO_DIR,
            stdout=f,
            check=True,
        )
    with tarfile.open(archive_path, "r") as tar:
        extract_tar(tar, destination)
    extension_dir = destination / "src"
    if not extension_dir.exists():
        raise SystemExit(f"git ref {git_ref} does not contain src/")


def read_release_notices() -> dict[str, bytes]:
    # Git releases run this publisher from the exported commit, never the caller's checkout.
    notices = {}
    for name in RELEASE_NOTICES:
        path = REPO_DIR / name
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"release source lacks regular file {name}")
        notices[name] = path.read_bytes()
    return notices


def extract_tar(tar: tarfile.TarFile, destination: Path) -> None:
    try:
        tar.extractall(destination, filter="data")
    except TypeError:
        tar.extractall(destination)


def copy_extension_worktree(source_dir: Path, destination: Path) -> Path:
    target = destination / "extension"
    shutil.copytree(
        source_dir,
        target,
        symlinks=True,
        ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc", "_metadata"),
    )
    return target


def compile_extension_sources(extension_dir: Path, *, bundle: bool, browser: str = "chrome") -> tuple[Path, dict[str, object]]:
    node = shutil.which("node")
    if not node:
        raise SystemExit("release compilation requires Node.js")
    if not DEFAULT_BUILD_SCRIPT.is_file():
        raise SystemExit(f"build script does not exist: {DEFAULT_BUILD_SCRIPT}")
    if browser not in {"chrome", "firefox"}:
        raise SystemExit(f"unknown browser: {browser}")
    # Chrome keeps compiled-extension. Firefox writes compiled-extension-firefox.
    output_dir = extension_dir.parent / ("compiled-extension-firefox" if browser == "firefox" else "compiled-extension")
    command = [
        node, str(DEFAULT_BUILD_SCRIPT), "--mode", "production", "--source-dir", str(extension_dir),
        "--output-dir", str(output_dir), "--debug-maps", "--json",
    ]
    if browser == "firefox":
        command.extend(["--browser", "firefox"])
    if not bundle:
        command.append("--no-bundle")

    result = subprocess.run(
        command,
        cwd=REPO_DIR,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(f"failed to compile extension: {detail}")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    try:
        summary = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        raise SystemExit("build script returned invalid metadata") from exc
    if not isinstance(summary, dict) or summary.get("formatVersion") != 1 or not isinstance(summary.get("bundling"), dict):
        raise SystemExit("build script returned invalid summary")
    return output_dir, summary["bundling"]


def refresh_dependency_provenance(extension_dir: Path, minification: dict[str, object]) -> None:
    # Capture final installed bytes after debug-map extraction; vendor builds stay immutable.
    result = subprocess.run(
        [shutil.which("node") or "node", str(REPO_DIR / "scripts/vendor/assets.mjs"), "--refresh",
         "--extension-dir", str(extension_dir), "--transform", str(minification.get("tool") or "release")],
        cwd=REPO_DIR, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit(f"failed to audit packaged dependencies: {result.stderr.strip() or result.stdout.strip()}")


def run_git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_DIR,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout




def archive_uses_root_manifest(target: str) -> bool:
    """Chrome Web Store and Firefox both require manifest.json as a direct child of the archive."""
    return target in {"webstore", "firefox"}


def release_paths(output_dir: Path, version: str, target: str = "manual") -> ReleasePaths:
    directory = output_dir / version
    suffix = ""
    package_name = PACKAGE_ROOT
    package_extension = ".zip"
    if target == "webstore":
        directory /= "webstore"
        suffix = ".webstore"
    elif target == "firefox":
        directory /= "firefox"
        package_name = FIREFOX_PACKAGE_NAME
        package_extension = ".xpi"
    return ReleasePaths(
        directory=directory,
        package=directory / f"{package_name}-{version}{suffix}{package_extension}",
        readme=directory / "README.md",
        version_json=directory / "version.json",
        debug=directory / f"{package_name}-{version}{suffix}.debug.zip",
    )


def collect_debug_files(extension_dir: Path) -> dict[str, bytes]:
    """Keep all source maps local; copied vendor runtime bytes stay untouched."""
    files: dict[str, bytes] = {}
    for path in sorted(extension_dir.rglob("*.map")):
        relative = path.relative_to(extension_dir)
        if relative.parts[0] == ".qingzhou-debug":
            continue
        runtime = path.with_suffix("")
        if not runtime.is_file():
            raise SystemExit(f"orphan release source map: {relative.as_posix()}")
        # The compiler owns this exact trailing directive. Terser omits it.
        text = runtime.read_text(encoding="utf-8")
        directive = f"//# sourceMappingURL={path.name}"
        if relative.parts[0] != "vendor" and text.rstrip().endswith(directive):
            runtime.write_text(text.rstrip()[:-len(directive)].rstrip() + "\n", encoding="utf-8")
        files[f"maps/{relative.as_posix()}"] = path.read_bytes()
        path.unlink()
    embedded = extension_dir / ".qingzhou-debug"
    if embedded.exists():
        for path in sorted(embedded.rglob("*")):
            if path.is_file():
                files[f"debug/{path.relative_to(embedded).as_posix()}"] = path.read_bytes()
        shutil.rmtree(embedded)
    build_manifest = extension_dir / ".qingzhou-build.json"
    if build_manifest.is_file():
        files["build.json"] = build_manifest.read_bytes()
        build_manifest.unlink()
    return files


def write_debug_package(output: ReleasePaths, files: dict[str, bytes], extension_dir: Path, *,
                        version: str, source: str, git_commit: str, package_sha256: str) -> None:
    entries = []
    for name, contents in sorted(files.items()):
        entry = {"path": name, "sha256": hashlib.sha256(contents).hexdigest()}
        if name.startswith("maps/"):
            runtime = name[len("maps/"):-len(".map")]
            entry.update({"runtimePath": runtime, "runtimeSha256": sha256_file(extension_dir / runtime)})
        entries.append(entry)
    manifest = {
        "formatVersion": 1, "version": version, "source": source, "gitCommit": git_commit,
        "package": {"name": output.package.name, "sha256": package_sha256}, "files": entries,
        "localOnly": True,
    }
    with zipfile.ZipFile(output.debug, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        write_zip_entry(archive, "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
        for name, contents in sorted(files.items()):
            write_zip_entry(archive, name, contents)


def iter_extension_files(extension_dir: Path) -> Iterable[Path]:
    for path in sorted(extension_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(extension_dir)
        parts = set(rel.parts)
        if parts & SKIP_DIRS:
            continue
        if path.name in SKIP_FILENAMES or path.suffix == ".pyc":
            continue
        yield path


def assert_no_remote_code(extension_dir: Path) -> None:
    script = REPO_DIR / "scripts" / "check-no-remote-code.mjs"
    node = shutil.which("node")
    if not node:
        raise SystemExit("remote-code check requires Node.js")
    result = subprocess.run(
        [node, str(script), str(extension_dir)],
        cwd=REPO_DIR,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise SystemExit(detail or "extension contains remotely hosted code")


def check_store_package(package: Path, report: Path) -> None:
    result = subprocess.run(
        [shutil.which("node") or "node", str(REPO_DIR / "scripts/check-store.mjs"), str(package), str(report)],
        cwd=REPO_DIR, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit(f"storecheck blocked the Web Store package; see {report}:\n{result.stderr or result.stdout}")


def audit_reviewable_code(extension_dir: Path) -> str:
    result = subprocess.run(
        [shutil.which("node") or "node", str(REPO_DIR / "scripts/check-reviewable-code.mjs"),
         "--json", str(extension_dir)], cwd=REPO_DIR, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit(result.stderr.strip() or "extension contains unreviewable code")
    return result.stdout


def make_package_zip(
    extension_dir: Path,
    files: list[Path],
    zip_path: Path,
    version: str,
    *,
    uncompressed_size: int,
    bundling: dict[str, object],
    target: str = "manual",
) -> None:
    zip_path.unlink(missing_ok=True)
    root_manifest = archive_uses_root_manifest(target)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(files, key=lambda item: item.relative_to(extension_dir).as_posix()):
            rel = path.relative_to(extension_dir).as_posix()
            write_zip_entry(zf, rel if root_manifest else f"{PACKAGE_ROOT}/{rel}", path.read_bytes())
        if root_manifest:
            return
        version_bytes = json.dumps(
            {
                "version": version,
                "packageRoot": PACKAGE_ROOT,
                "fileCount": len(files),
                "uncompressedSize": uncompressed_size,
                "bundling": bundling,
            },
            ensure_ascii=False,
            indent=2,
        ).encode("utf-8")
        write_zip_entry(zf, "version.json", version_bytes)


def validate_webstore_package(path: Path) -> None:
    """Check the upload archive after compilation and debug-file separation."""
    if path.stat().st_size > 2 * 1024**3:
        raise ValueError("Chrome Web Store packages must be at most 2 GiB")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        files = set(names)
        if len(files) != len(names):
            raise ValueError("duplicate Web Store ZIP entries")
        for name in names:
            if "\\" in name or ":" in name or any(part in {"", ".", "..", *SKIP_DIRS} for part in name.split("/")):
                raise ValueError(f"invalid Web Store ZIP path: {name}")
            if name.endswith("/manifest.json"):
                raise ValueError(f"extra manifest in Web Store ZIP: {name}")
            if name.endswith((".map", ".debug.zip")) or any(part.startswith((".qingzhou-", ".env")) for part in name.split("/")):
                raise ValueError(f"development file in Web Store ZIP: {name}")
        if "manifest.json" not in files:
            raise ValueError("Web Store ZIP requires manifest.json at its root")
        manifest = json.loads(archive.read("manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
            raise ValueError("Web Store ZIP requires Manifest V3")
        if "key" in manifest:
            raise ValueError("Web Store manifest must not contain key")
        version = manifest.get("version", "")
        try:
            if normalize_version(version) != version:
                raise ValueError("Web Store manifest requires a numeric version")
        except SystemExit as error:
            raise ValueError(str(error)) from error
        required = set(RELEASE_NOTICES)
        required.update(manifest.get("icons", {}).values())
        required.update(manifest.get("sandbox", {}).get("pages", []))
        for section, key in [("background", "service_worker"), ("side_panel", "default_path"),
                             ("action", "default_popup"), ("options_ui", "page")]:
            if entry := manifest.get(section, {}).get(key):
                required.add(entry)
        icons = manifest.get("action", {}).get("default_icon", {})
        required.update([icons] if isinstance(icons, str) else icons.values())
        for key in ("options_page", "devtools_page"):
            if entry := manifest.get(key):
                required.add(entry)
        for script in manifest.get("content_scripts", []):
            required.update(script.get("js", []))
            required.update(script.get("css", []))
        required.update(rule["path"] for rule in manifest.get("declarative_net_request", {}).get("rule_resources", []))
        if locale := manifest.get("default_locale"):
            required.add(f"_locales/{locale}/messages.json")
        missing = required - files
        if missing:
            raise ValueError(f"missing Web Store package resources: {sorted(missing)}")
        if corrupt := archive.testzip():
            raise ValueError(f"corrupt Web Store ZIP entry: {corrupt}")


def validate_firefox_package(path: Path) -> None:
    """Check the unsigned Add-ons Manager archive after compilation and debug-file separation.

    AMO accepts a zip of the extension files. manifest.json is a direct child of the archive.
    The package stays unsigned; Add-ons Manager adds META-INF when it signs the upload.
    """
    if path.suffix != ".xpi":
        raise ValueError("Firefox package must use the .xpi extension")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        files = set(names)
        if len(files) != len(names):
            raise ValueError("duplicate Firefox ZIP entries")
        for name in names:
            if "\\" in name or ":" in name or any(part in {"", ".", "..", *SKIP_DIRS} for part in name.split("/")):
                raise ValueError(f"invalid Firefox ZIP path: {name}")
            lowered = name.lower()
            if lowered.startswith("meta-inf/") or "/meta-inf/" in lowered:
                raise ValueError(f"pre-signed file in Firefox ZIP: {name}")
            if name.endswith("/manifest.json"):
                raise ValueError(f"extra manifest in Firefox ZIP: {name}")
            if name.endswith((".map", ".ts", ".tsx", ".debug.zip")) or any(
                part.startswith((".qingzhou-", ".env")) for part in name.split("/")
            ):
                raise ValueError(f"development file in Firefox ZIP: {name}")
        if "manifest.json" not in files:
            raise ValueError("Firefox ZIP requires manifest.json at its root")
        if "version.json" in files:
            raise ValueError("Firefox ZIP must contain extension files only")
        manifest = json.loads(archive.read("manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
            raise ValueError("Firefox ZIP requires Manifest V3")
        if "key" in manifest:
            raise ValueError("Firefox manifest must not contain key")
        gecko = manifest.get("browser_specific_settings", {})
        gecko = gecko.get("gecko", {}) if isinstance(gecko, dict) else {}
        if not isinstance(gecko, dict) or gecko.get("id") != FIREFOX_GECKO_ID:
            raise ValueError(f"Firefox manifest must keep browser_specific_settings.gecko.id {FIREFOX_GECKO_ID}")
        if not str(gecko.get("strict_min_version") or "").strip():
            raise ValueError("Firefox manifest must keep gecko.strict_min_version")
        required_collection = gecko.get("data_collection_permissions", {})
        required_collection = required_collection.get("required", []) if isinstance(required_collection, dict) else []
        for name in FIREFOX_DATA_COLLECTION_REQUIRED:
            if name not in required_collection:
                raise ValueError(f"Firefox manifest must keep data collection permission {name}")
        permissions = manifest.get("permissions") or []
        for name in FIREFOX_KEPT_PERMISSIONS:
            if name not in permissions:
                raise ValueError(f"Firefox manifest must keep permission {name}")
        version = manifest.get("version", "")
        try:
            if normalize_version(version) != version:
                raise ValueError("Firefox manifest requires a numeric version")
        except SystemExit as error:
            raise ValueError(str(error)) from error
        required = set(RELEASE_NOTICES)
        required.update(manifest.get("icons", {}).values())
        required.update(manifest.get("sandbox", {}).get("pages", []))
        required.update(manifest.get("background", {}).get("scripts", []))
        sidebar = manifest.get("sidebar_action", {})
        if isinstance(sidebar, dict):
            if panel := sidebar.get("default_panel"):
                required.add(panel)
            icons = sidebar.get("default_icon", {})
            required.update([icons] if isinstance(icons, str) else icons.values())
        action_icons = manifest.get("action", {}).get("default_icon", {})
        required.update([action_icons] if isinstance(action_icons, str) else action_icons.values())
        for script in manifest.get("content_scripts", []):
            required.update(script.get("js", []))
            required.update(script.get("css", []))
        required.update(rule["path"] for rule in manifest.get("declarative_net_request", {}).get("rule_resources", []))
        if locale := manifest.get("default_locale"):
            required.add(f"_locales/{locale}/messages.json")
        missing = required - files
        if missing:
            raise ValueError(f"missing Firefox package resources: {sorted(missing)}")
        if corrupt := archive.testzip():
            raise ValueError(f"corrupt Firefox ZIP entry: {corrupt}")


def write_zip_entry(archive: zipfile.ZipFile, name: str, contents: bytes) -> None:
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.create_system = 3
    entry.external_attr = 0o100644 << 16
    entry.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(entry, contents, compresslevel=9)


def build_readme(
    *,
    version: str,
    title: str,
    summary: str,
    features: list[str],
    notes: str,
) -> str:
    final_title = title.strip() or f"qz {version}"
    final_summary = summary.strip() or f"qz {version} release."
    final_features = [item.strip() for item in features if item.strip()]
    lines = [
        f"# {final_title}",
        "",
        final_summary,
        "",
        "## Changes",
        "",
    ]
    lines.extend(f"- {item}" for item in final_features)
    if notes.strip():
        lines.extend(["", "## Notes", "", textwrap.dedent(notes).strip()])
    lines.append("")
    return "\n".join(lines)








def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
