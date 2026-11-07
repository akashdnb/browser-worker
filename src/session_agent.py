from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
from typing import Any

MAX_COMPONENT_BYTES = 256 * 1024 * 1024
CHUNK_BYTES = 192 * 1024

_CREDENTIAL_PATHS = (
    ".config/gh",
    ".aws",
    ".config/gcloud",
    ".npmrc",
    ".ssh",
)
_EXCLUDED_NAMES = {
    ".git-credentials",
    "credentials.db-journal",
    "cookies-journal",
    "lock",
}


def _archive_paths(paths: list[Path]) -> bytes:
    existing = [path for path in paths if path.exists()]
    if not existing:
        return b""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for path in existing:
            if not path.exists() or path.name in _EXCLUDED_NAMES:
                continue
            try:
                archive.add(path, arcname=str(path.relative_to(Path.home())), recursive=True, filter=_safe_tar_info)
            except (OSError, ValueError):
                continue
    data = output.getvalue()
    if len(data) > MAX_COMPONENT_BYTES:
        raise ValueError("captured archive exceeds the 256 MiB component limit")
    return data


def _safe_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    parts = Path(info.name).parts
    if any(part in {".git", "node_modules", "__pycache__"} for part in parts):
        return None
    if Path(info.name).name in _EXCLUDED_NAMES:
        return None
    # Preserve symlinks as links; never dereference them into arbitrary paths.
    return info


def _run(command: list[str]) -> tuple[int, str, str]:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
        return result.returncode, result.stdout, result.stderr[-2000:]
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", f"{type(exc).__name__}: {exc}"


def _package_inventory() -> bytes:
    inventory: dict[str, Any] = {"format_version": 1, "runtime": {}, "packages": {}, "warnings": []}
    inventory["runtime"] = {
        "os": "ubuntu" if Path("/etc/os-release").exists() else os.name,
        "architecture": os.uname().machine if hasattr(os, "uname") else "unknown",
        "python": os.sys.version.split()[0],
        "node": _run(["node", "--version"])[1].strip() or None,
    }
    code, stdout, stderr = _run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"])
    inventory["packages"]["apt"] = [
        {"name": line.split("\t", 1)[0], "version": line.split("\t", 1)[1]}
        for line in stdout.splitlines() if "\t" in line
    ] if code == 0 else []
    if code != 0 and stderr:
        inventory["warnings"].append("APT inventory unavailable")
    code, stdout, _ = _run([os.sys.executable, "-m", "pip", "list", "--format=json"])
    try:
        inventory["packages"]["pip"] = json.loads(stdout) if code == 0 else []
    except json.JSONDecodeError:
        inventory["packages"]["pip"] = []
        inventory["warnings"].append("Python package inventory could not be parsed")
    code, stdout, _ = _run(["npm", "ls", "--global", "--depth=0", "--json"])
    try:
        npm = json.loads(stdout) if stdout.strip() else {}
        inventory["packages"]["npm"] = [
            {"name": name, "version": details.get("version")}
            for name, details in npm.get("dependencies", {}).items()
        ]
    except (json.JSONDecodeError, AttributeError):
        inventory["packages"]["npm"] = []
        inventory["warnings"].append("npm package inventory unavailable")
    return json.dumps(inventory, separators=(",", ":")).encode()


def extract_session_components(requested: list[str]) -> tuple[dict[str, bytes], dict[str, str]]:
    if not isinstance(requested, list) or not requested or len(requested) > 3:
        raise ValueError("invalid session component selection")
    allowed = {"credentials", "packages", "browser"}
    if any(item not in allowed for item in requested):
        raise ValueError("unsupported session component")
    captured: dict[str, bytes] = {}
    errors: dict[str, str] = {}
    home = Path.home()
    for component in requested:
        try:
            if component == "credentials":
                paths = [home / relative for relative in _CREDENTIAL_PATHS]
                captured[component] = _archive_paths(paths)
                if not captured[component]:
                    raise ValueError("no supported credential files were found")
            elif component == "packages":
                captured[component] = _package_inventory()
            elif component == "browser":
                configured = os.environ.get("BROWSER_WORKER_PROFILE_DIR", "").strip()
                candidates = [Path(configured)] if configured else [
                    home / ".config" / "browser-mcp" / "auth"
                ]
                profile = next((path for path in candidates if path.is_dir()), None)
                if profile is None:
                    raise ValueError("no supported browser profile directory is available on this worker")
                captured[component] = _archive_paths([profile])
        except Exception as exc:
            errors[component] = f"{type(exc).__name__}: {str(exc)[:300]}"
    return captured, errors



def _extract_archive(data: bytes, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        safe_members = []
        for member in archive.getmembers():
            name = Path(member.name)
            if name.is_absolute() or ".." in name.parts or member.issym() or member.islnk():
                raise ValueError("session archive contains an unsafe path or link")
            if member.isdir() or member.isfile():
                safe_members.append(member)
        archive.extractall(destination, members=safe_members)


def restore_session_components(components: dict[str, bytes]) -> dict[str, str]:
    errors: dict[str, str] = {}
    home = Path.home()
    for component, payload in components.items():
        try:
            if component in {"credentials", "browser"}:
                _extract_archive(payload, home)
                if component == "credentials":
                    for relative in (".ssh", ".aws", ".config/gh"):
                        folder = home / relative
                        if folder.is_dir():
                            folder.chmod(0o700 if relative == ".ssh" else 0o700)
                            for item in folder.rglob("*"):
                                if item.is_file():
                                    item.chmod(0o600)
                    npmrc = home / ".npmrc"
                    if npmrc.exists():
                        npmrc.chmod(0o600)
            elif component == "packages":
                inventory = json.loads(payload)
                if not isinstance(inventory, dict) or not isinstance(inventory.get("packages"), dict):
                    raise ValueError("invalid package inventory")
                packages = inventory["packages"]
                apt = [str(item.get("name")) for item in packages.get("apt", []) if isinstance(item, dict) and item.get("name")]
                pip = [f"{item['name']}=={item['version']}" for item in packages.get("pip", []) if isinstance(item, dict) and item.get("name") and item.get("version")]
                npm = [f"{item['name']}@{item['version']}" for item in packages.get("npm", []) if isinstance(item, dict) and item.get("name") and item.get("version")]
                if apt:
                    update = _run(["sudo", "apt-get", "-o", "Acquire::Retries=3", "update"])
                    if update[0] == 0:
                        result = _run(["sudo", "apt-get", "install", "-y", "--no-install-recommends", *apt[:250]])
                        if result[0] != 0:
                            errors["packages.apt"] = result[2] or "APT package restoration failed"
                    else:
                        errors["packages.apt"] = update[2] or "APT package index refresh failed"
                if pip:
                    result = _run([os.sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *pip[:500]])
                    if result[0] != 0:
                        errors["packages.pip"] = result[2] or "Python package restoration failed"
                if npm:
                    result = _run(["npm", "install", "--global", *npm[:250]])
                    if result[0] != 0:
                        errors["packages.npm"] = result[2] or "npm package restoration failed"
                target = home / ".config" / "utils-worker-session"
                target.mkdir(parents=True, exist_ok=True)
                (target / "packages.json").write_bytes(payload)
        except Exception as exc:
            errors[component] = f"{type(exc).__name__}: {str(exc)[:300]}"
    return errors


async def receive_session_restore(websocket) -> dict[str, str]:
    first = json.loads(await websocket.recv())
    if first.get("type") == "worker.session.restore.none":
        return {}
    if first.get("type") == "worker.session.restore.error":
        return {"session": str(first.get("error") or "session transfer failed")[:300]}
    if first.get("type") != "worker.session.restore.start":
        raise RuntimeError("expected worker session restore handshake")
    expected = first.get("components")
    if not isinstance(expected, list) or not expected:
        raise RuntimeError("worker session restore has no selected components")
    uploads: dict[str, dict[int, bytes]] = {str(item): {} for item in expected}
    while True:
        message = json.loads(await websocket.recv())
        kind = message.get("type")
        if kind == "worker.session.restore.chunk":
            component = message.get("component")
            index = message.get("chunk_index")
            encoded = message.get("data")
            if component not in uploads or isinstance(index, bool) or not isinstance(index, int) or index < 0:
                continue
            if not isinstance(encoded, str) or len(encoded) > 360_000:
                continue
            try:
                chunk = base64.b64decode(encoded, validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            current = uploads[component]
            if index not in current and sum(len(value) for value in current.values()) + len(chunk) <= MAX_COMPONENT_BYTES:
                current[index] = chunk
        elif kind == "worker.session.restore.complete":
            break
        elif kind == "worker.session.restore.error":
            return {"session": str(message.get("error") or "session transfer failed")[:300]}
    components: dict[str, bytes] = {}
    errors: dict[str, str] = {}
    for component, chunks in uploads.items():
        if not chunks or sorted(chunks) != list(range(len(chunks))):
            errors[component] = "session component transfer was incomplete"
        else:
            components[component] = b"".join(chunks[index] for index in range(len(chunks)))
    if components:
        errors.update(await asyncio.to_thread(restore_session_components, components))
    return errors


async def send_session_snapshot(websocket, request_id: str, requested: list[str], send_json) -> None:
    try:
        components, errors = await asyncio.to_thread(extract_session_components, requested)
        for component, payload in components.items():
            for index, offset in enumerate(range(0, len(payload), CHUNK_BYTES)):
                chunk = payload[offset:offset + CHUNK_BYTES]
                await send_json(websocket, {
                    "type": "worker.session.snapshot.chunk",
                    "request_id": request_id,
                    "component": component,
                    "chunk_index": index,
                    "data": base64.b64encode(chunk).decode("ascii"),
                })
        if components:
            await send_json(websocket, {
                "type": "worker.session.snapshot.complete",
                "request_id": request_id,
                "captured_components": sorted(components),
                "errors": errors,
            })
        else:
            await send_json(websocket, {
                "type": "worker.session.snapshot.error",
                "request_id": request_id,
                "error": "; ".join(f"{key}: {value}" for key, value in errors.items()) or "no components could be captured",
            })
    except Exception as exc:
        await send_json(websocket, {
            "type": "worker.session.snapshot.error",
            "request_id": request_id,
            "error": f"{type(exc).__name__}: {str(exc)[:400]}",
        })
