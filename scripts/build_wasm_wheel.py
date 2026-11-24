#!/usr/bin/env python3
"""Build a Pyodide-compatible ``markitdown`` wheel from microsoft/markitdown.

The upstream package declares native dependencies (magika -> onnxruntime) that
cannot be imported in Pyodide. This script:

  1. clones/checks out a source tree and records its exact commit,
  2. removes native-only dependencies from pyproject.toml,
  3. builds a pure-Python wheel with ``python -m build``,
  4. strips all remaining Requires-Dist entries so micropip never tries to
     resolve dependencies at runtime,
  5. writes a SHA-stamped wheel plus dist/version.json for cache busting.

Usage:
    python scripts/build_wasm_wheel.py --dist dist
    python scripts/build_wasm_wheel.py --source /path/to/markitdown --dist dist

Requires Python 3.11+ and: python -m pip install build hatchling tomlkit
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path
from typing import Any, Iterable

# Packages that either ship native extensions or are simply not needed by the
# browser build. magika is the critical one: it pulls in onnxruntime.
INCOMPATIBLE_DEPENDENCIES = {
    "magika",
    "onnxruntime",
    "onnxruntime-web",
    "onnxruntime-tools",
    "numpy",
    "pandas",
    "scipy",
    "pyarrow",
    "torch",
    "tensorflow",
    "opencv-python",
    "opencv-python-headless",
    "pdfplumber",
    "pypdfium2",
    "pydub",
    "speechrecognition",
    "youtube-transcript-api",
    "azure-ai-documentintelligence",
    "azure-ai-contentunderstanding",
    "azure-identity",
    "olefile",
}
INCOMPATIBLE_PREFIXES = ("onnxruntime", "azure-", "pdfplumber", "pypdfium")

ARRAY_ASSIGNMENT = re.compile(
    r"(?m)^(?P<indent>\s*)(?P<key>[A-Za-z0-9_-]+)\s*=\s*\[(?P<body>[^\]]*)\]"
)


def run(command: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return result.stdout.strip()


def package_name(spec: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", spec)
    if not match:
        return ""
    return match.group(1).lower().replace("_", "-")


def is_incompatible(spec: str) -> bool:
    name = package_name(spec)
    if not name:
        return False
    return name in INCOMPATIBLE_DEPENDENCIES or name.startswith(INCOMPATIBLE_PREFIXES)


def filter_dependencies(items: Iterable[Any]) -> list[str]:
    return [str(item) for item in items if not is_incompatible(str(item))]


def patch_with_tomlkit(path: Path) -> bool:
    try:
        import tomlkit
    except ImportError:
        return False

    document = tomlkit.parse(path.read_text(encoding="utf-8"))
    project = document.get("project")
    if not hasattr(project, "get"):
        return True

    dependencies = project.get("dependencies")
    if isinstance(dependencies, list):
        project["dependencies"] = filter_dependencies(dependencies)

    extras = project.get("optional-dependencies")
    if hasattr(extras, "get"):
        for extra_name in list(extras.keys()):
            values = extras[extra_name]
            if isinstance(values, list):
                extras[extra_name] = filter_dependencies(values)

    path.write_text(tomlkit.dumps(document), encoding="utf-8")
    return True


def patch_with_text(path: Path) -> None:
    """Fallback patcher for environments without tomlkit."""
    text = path.read_text(encoding="utf-8")

    def replace(match: re.Match[str]) -> str:
        if match.group("key") != "dependencies":
            return match.group(0)
        entries = [part.strip() for part in match.group("body").split(",") if part.strip()]
        kept = [entry for entry in entries if not is_incompatible(entry.strip("\"'"))]
        body = ", ".join(kept)
        return f'{match.group("indent")}dependencies = [{body}]'

    text = ARRAY_ASSIGNMENT.sub(replace, text)
    path.write_text(text, encoding="utf-8")


def patch_pyproject(pyproject: Path) -> None:
    if not patch_with_tomlkit(pyproject):
        patch_with_text(pyproject)

    parsed = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    name = str(parsed.get("project", {}).get("name", "")).lower()
    if name != "markitdown":
        raise RuntimeError(f"Expected the markitdown project in {pyproject}, found {name!r}")

    dependencies = parsed.get("project", {}).get("dependencies", [])
    remaining = [spec for spec in dependencies if is_incompatible(str(spec))]
    if remaining:
        raise RuntimeError(f"Native dependencies were not removed: {remaining}")


def find_package_dir(source: Path) -> tuple[Path, Path]:
    candidates = [
        source / "packages" / "markitdown",
        source / "markitdown",
        source,
    ]
    for candidate in candidates:
        pyproject = candidate / "pyproject.toml"
        if not pyproject.exists():
            continue
        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError:
            continue
        if str(data.get("project", {}).get("name", "")).lower() == "markitdown":
            return candidate, pyproject
    raise RuntimeError(f"Could not find the markitdown package under {source}")


def commit_sha(source: Path) -> str:
    return run(["git", "-C", str(source), "rev-parse", "HEAD"])


def clone_upstream(repo_url: str, ref: str, destination: Path) -> None:
    run(
        [
            "git", "clone", "--depth", "1", "--branch", ref,
            repo_url, str(destination),
        ]
    )


def build_wheel(package_dir: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    run(
        [
            sys.executable, "-m", "build", "--wheel", "--no-isolation",
            "--outdir", str(output_dir),
        ],
        cwd=package_dir,
    )
    wheels = sorted(output_dir.glob("*.whl"), key=lambda item: item.stat().st_mtime)
    if not wheels:
        raise RuntimeError("python -m build did not produce a wheel")
    return wheels[-1]


def sanitize_wheel(source_wheel: Path, destination: Path) -> None:
    """Drop runtime dependencies from metadata and keep RECORD consistent."""
    with zipfile.ZipFile(source_wheel) as archive:
        entries = [
            (info, info.filename, archive.read(info.filename))
            for info in archive.infolist()
        ]

    metadata_name = next(
        (name for _, name, _ in entries if name.endswith(".dist-info/METADATA")),
        None,
    )
    if metadata_name is None:
        raise RuntimeError(f"No METADATA found in {source_wheel}")

    record_name = metadata_name.rsplit("/", 1)[0] + "/RECORD"
    original_metadata = next(
        payload for _, name, payload in entries if name == metadata_name
    )
    cleaned_metadata = "\n".join(
        line
        for line in original_metadata.decode("utf-8").splitlines()
        if not line.startswith("Requires-Dist:")
    ).rstrip() + "\n"

    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for info, name, payload in entries:
            if name == metadata_name:
                payload = cleaned_metadata.encode("utf-8")
            if name == record_name:
                continue
            archive.writestr(info.filename, payload)

        record_lines: list[str] = []
        for _, name, payload in entries:
            if name == record_name:
                continue
            if name == metadata_name:
                payload = cleaned_metadata.encode("utf-8")
            digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).rstrip(b"=").decode("ascii")
            record_lines.append(f"{name},sha256={digest},{len(payload)}")
        record_lines.append(f"{record_name},,")
        archive.writestr(record_name, "\n".join(record_lines) + "\n")


def write_version(
    dist_dir: Path,
    sha: str,
    short_sha: str,
    wheel_filename: str,
    built_at: str,
) -> Path:
    version = {
        "sha": sha,
        "shortSha": short_sha,
        "commit": sha,
        "wheel": f"wheels/{wheel_filename}",
        "wheelFilename": wheel_filename,
        "builtAt": built_at,
        "source": "microsoft/markitdown",
        "sourceUrl": "https://github.com/microsoft/markitdown",
    }
    target = dist_dir / "version.json"
    target.write_text(json.dumps(version, indent=2) + "\n", encoding="utf-8")
    return target


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Local markitdown checkout (skips cloning)")
    parser.add_argument("--repo-url", default="https://github.com/microsoft/markitdown.git")
    parser.add_argument("--ref", default="main", help="Branch or tag to build")
    parser.add_argument("--dist", type=Path, default=Path("dist"), help="Output directory")
    parser.add_argument("--keep-source", action="store_true", help="Keep a temporary clone")
    return parser.parse_args()


def main() -> int:
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer is required")

    args = parse_args()
    dist_dir = args.dist.resolve()
    temporary_root: Path | None = None
    source = args.source.resolve() if args.source else None

    if source is None:
        temporary_root = Path(tempfile.mkdtemp(prefix="markitdown-wasm-"))
        source = temporary_root / "markitdown"
        print(f"Cloning {args.repo_url}@{args.ref} ...")
        clone_upstream(args.repo_url, args.ref, source)

    try:
        sha = commit_sha(source)
        short_sha = sha[:7]
        package_dir, pyproject = find_package_dir(source)
        print(f"Building {package_dir} at {sha}")

        patch_pyproject(pyproject)

        with tempfile.TemporaryDirectory(prefix="markitdown-wheel-") as raw_dir:
            raw_wheel = build_wheel(package_dir, Path(raw_dir))
            wheel_filename = f"markitdown-{short_sha}-py3-none-any.whl"
            target_wheel = dist_dir / "wheels" / wheel_filename
            sanitize_wheel(raw_wheel, target_wheel)

        built_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        version_file = write_version(dist_dir, sha, short_sha, wheel_filename, built_at)

        print(json.dumps({
            "sha": sha,
            "wheel": str(target_wheel),
            "version": str(version_file),
            "builtAt": built_at,
        }, indent=2))
        return 0
    finally:
        if temporary_root is not None and not args.keep_source:
            shutil.rmtree(temporary_root, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"Command failed: {error.cmd}\n{error.output}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:  # noqa: BLE001 - build scripts should fail loudly
        print(f"Build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
