from __future__ import annotations

import atexit
import asyncio
import base64
import contextlib
import json
import os
import socket
import stat
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect

from session_agent import receive_session_restore, send_session_snapshot

MAX_CHUNK = 16_384
SETUP_REQUEST_ID = "environment-setup"
_SEND_LOCK = asyncio.Lock()


async def _send_json(websocket, payload: dict) -> None:
    async with _SEND_LOCK:
        await websocket.send(json.dumps(payload))


async def _status(
    websocket,
    status: str,
    message: str,
    *,
    task_id: str | None = None,
    task_name: str | None = None,
    task_status: str | None = None,
    duration_seconds: float | None = None,
) -> None:
    payload = {
        "type": "worker.status",
        "environment_status": status,
        "message": message,
    }
    if task_id:
        payload["task"] = {
            "id": task_id,
            "name": task_name or task_id,
            "status": task_status or status,
            "message": message,
            "duration_seconds": duration_seconds,
            "updated_at": time.time(),
        }
    await _send_json(websocket, payload)


async def _stream_process(
    websocket,
    command: list[str] | str,
    *,
    request_id: str,
    shell: bool = False,
    timeout: int = 600,
) -> None:
    process = await asyncio.create_subprocess_shell(
        command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    ) if shell else await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )

    async def pump() -> None:
        while True:
            chunk = await process.stdout.read(MAX_CHUNK)
            if not chunk:
                break
            await _send_json(websocket, {
                "type": "worker.output", "request_id": request_id,
                "stream": "stdout", "data": chunk.decode("utf-8", errors="replace"),
            })

    pump_task = asyncio.create_task(pump())
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, 9)
        await process.wait()
        await pump_task
        raise RuntimeError(f"Timed out after {timeout}s")
    await pump_task
    if process.returncode:
        raise RuntimeError(f"Exited with code {process.returncode}")


async def _run_setup_task(
    websocket,
    *,
    task_id: str,
    name: str,
    command: list[str] | str,
    shell: bool = False,
    timeout: int = 600,
    retries: int = 2,
) -> dict:
    started = time.monotonic()
    request_id = f"environment-setup:{task_id}"
    for attempt in range(1, retries + 2):
        await _status(
            websocket, "preparing",
            f"{name}: attempt {attempt}/{retries + 1}",
            task_id=task_id, task_name=name, task_status="running",
        )
        try:
            await _stream_process(
                websocket, command, request_id=request_id,
                shell=shell, timeout=timeout,
            )
            duration = round(time.monotonic() - started, 3)
            await _status(
                websocket, "preparing", f"{name}: completed",
                task_id=task_id, task_name=name, task_status="completed",
                duration_seconds=duration,
            )
            return {"id": task_id, "name": name, "status": "completed", "duration_seconds": duration}
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            await _send_json(websocket, {
                "type": "worker.output", "request_id": request_id,
                "stream": "stderr",
                "data": f"[{name}] attempt {attempt} failed: {detail}\n",
            })
            if attempt <= retries:
                await _status(
                    websocket, "preparing",
                    f"{name}: retrying after failure ({attempt}/{retries})",
                    task_id=task_id, task_name=name, task_status="retrying",
                )
                await asyncio.sleep(min(2 ** attempt, 10))
                continue
            duration = round(time.monotonic() - started, 3)
            await _status(
                websocket, "preparing", f"{name}: failed — {detail}",
                task_id=task_id, task_name=name, task_status="failed",
                duration_seconds=duration,
            )
            return {
                "id": task_id, "name": name, "status": "failed",
                "message": detail, "duration_seconds": duration,
            }


async def _provision(websocket, profiles_json: str, setup_json: str, restore_errors: dict[str, str] | None = None) -> None:
    try:
        profiles = json.loads(profiles_json or '["minimal"]')
        setup = json.loads(setup_json or "{}")
        allowed_profiles = {"minimal", "python", "node", "playwright-chromium", "devops"}
        allowed_setup = {"apt_packages", "pip_packages", "npm_packages", "commands"}
        if (not isinstance(profiles, list) or not profiles
                or any(not isinstance(profile, str) or profile not in allowed_profiles for profile in profiles)
                or not isinstance(setup, dict) or set(setup) - allowed_setup):
            raise RuntimeError("Invalid environment configuration")
        for key in allowed_setup:
            if key not in setup:
                setup[key] = []
            if not isinstance(setup[key], list) or any(not isinstance(item, str) or not item.strip() for item in setup[key]):
                raise RuntimeError(f"Invalid setup entries for {key}")

        tasks: list[dict] = []
        apt = list(setup.get("apt_packages", []))
        if "devops" in profiles:
            apt += ["jq", "yq", "ripgrep", "shellcheck"]
        apt = list(dict.fromkeys(apt))
        if apt:
            # APT must be serialized as one package-manager transaction. Its
            # network fetches use APT's own retry mechanism.
            update = await _run_setup_task(
                websocket, task_id="apt-update", name="APT package index refresh",
                command=["sudo", "apt-get", "-o", "Acquire::Retries=3",
                         "-o", "Acquire::http::Timeout=60",
                         "-o", "Acquire::https::Timeout=60", "update"],
                timeout=600,
            )
            tasks.append(update)
            if update["status"] == "completed":
                tasks.append(await _run_setup_task(
                    websocket, task_id="apt-install", name=f"APT packages ({', '.join(apt)})",
                    command=["sudo", "apt-get", "-o", "Acquire::Retries=3",
                             "-o", "Acquire::http::Timeout=60",
                             "-o", "Acquire::https::Timeout=60",
                             "install", "-y", "--no-install-recommends", *apt],
                    timeout=1200,
                ))
            else:
                await _status(
                    websocket, "preparing", "APT package installation: skipped because package index refresh failed",
                    task_id="apt-install", task_name="APT package installation",
                    task_status="skipped",
                )
                tasks.append({
                    "id": "apt-install", "name": "APT package installation",
                    "status": "skipped", "message": "Skipped because APT index refresh failed",
                })

        pip = list(setup.get("pip_packages", []))
        if "playwright-chromium" in profiles:
            pip.append("playwright")
        pip = list(dict.fromkeys(pip))
        if pip:
            tasks.append({
                "id": "pip-install", "name": f"Python packages ({', '.join(pip)})",
                "command": ["python", "-m", "pip", "install", "--disable-pip-version-check", *pip],
                "timeout": 900,
            })
        if "playwright-chromium" in profiles:
            tasks.append({
                "id": "playwright-chromium", "name": "Playwright Chromium",
                "command": ["python", "-m", "playwright", "install", "--with-deps", "chromium"],
                "timeout": 1200,
            })
        npm = list(dict.fromkeys(setup.get("npm_packages", [])))
        if npm:
            tasks.append({
                "id": "npm-install", "name": f"Global npm packages ({', '.join(npm)})",
                "command": ["npm", "install", "--global", *npm],
                "timeout": 900,
            })
        for index, command in enumerate(setup.get("commands", []), start=1):
            tasks.append({
                "id": f"custom-{index}", "name": f"Custom setup command {index}",
                "command": command, "shell": True, "timeout": 600,
            })

        async def run_task(task: dict) -> dict:
            return await _run_setup_task(
                websocket, task_id=task["id"], name=task["name"],
                command=task["command"], shell=task.get("shell", False),
                timeout=task.get("timeout", 600),
            )

        # Run independent package managers concurrently, but keep APT as a
        # single serialized transaction and preserve dependency ordering.
        results_by_id: dict[str, dict] = {}
        package_tasks = [task for task in tasks if task["id"] in {"pip-install", "npm-install"}]
        package_results = await asyncio.gather(
            *(run_task(task) for task in package_tasks), return_exceptions=True
        )
        for task, result in zip(package_tasks, package_results):
            results_by_id[task["id"]] = result if isinstance(result, dict) else {
                "id": task["id"], "name": task["name"], "status": "failed",
                "message": f"{type(result).__name__}: {result}",
            }

        playwright_task = next((task for task in tasks if task["id"] == "playwright-chromium"), None)
        if playwright_task:
            pip_result = results_by_id.get("pip-install", {"status": "completed"})
            if pip_result.get("status") == "completed":
                results_by_id["playwright-chromium"] = await run_task(playwright_task)
            else:
                results_by_id["playwright-chromium"] = {
                    "id": "playwright-chromium", "name": "Playwright Chromium",
                    "status": "skipped", "message": "Skipped because Playwright Python package installation failed",
                }
                await _status(
                    websocket, "preparing", "Playwright Chromium: skipped because pip installation failed",
                    task_id="playwright-chromium", task_name="Playwright Chromium",
                    task_status="skipped",
                )

        # Custom commands run after package installation, in declared order;
        # users often use them to configure or validate installed packages.
        for task in [item for item in tasks if item["id"].startswith("custom-")]:
            results_by_id[task["id"]] = await run_task(task)

        results = [*tasks]
        # Replace task definitions with their execution results.
        final_tasks = [item for item in results if "command" not in item]
        final_tasks.extend(results_by_id.values())
        failed = [task for task in final_tasks if task.get("status") in {"failed", "skipped"}]
        completed = [task for task in final_tasks if task.get("status") == "completed"]
        restore_errors = restore_errors or {}
        if failed or restore_errors:
            overall = "partially_ready" if completed or restore_errors else "failed"
            summary = f"Environment setup finished: {len(completed)} setup tasks completed, {len(failed)} failed or skipped, {len(restore_errors)} restore errors"
            await _status(websocket, overall, summary)
        else:
            await _status(websocket, "ready", "Environment is ready")
    except Exception as exc:
        with contextlib.suppress(Exception):
            await _send_json(websocket, {
                "type": "worker.output", "request_id": "environment-setup:validation",
                "stream": "stderr", "data": f"Environment setup configuration error: {exc}\n",
            })
            await _status(websocket, "failed", str(exc)[:500])


_EXECUTION_ENV_KEYS = {"UTILS_YOUTUBE_ACCESS_TOKEN", "UTILS_YOUTUBE_GRANTED_SCOPES"}


def _execution_environment(message: dict, inherited: dict[str, str]) -> dict[str, str]:
    env = inherited.copy()
    env.pop("UTILS_WORKER_TOKEN", None)
    env.pop("UTILS_WORKER_AUTH_TOKEN", None)
    for key in _EXECUTION_ENV_KEYS:
        env.pop(key, None)
    supplied = message.get("environment", {})
    if not isinstance(supplied, dict) or set(supplied) - _EXECUTION_ENV_KEYS:
        raise ValueError("worker execution message contains an unapproved environment key")
    for key, value in supplied.items():
        if not isinstance(value, str) or not value or len(value) > 8192 or "\x00" in value:
            raise ValueError("worker execution message contains an invalid environment value")
        env[key] = value
    return env


async def _execute(websocket, message: dict, active_processes: dict) -> None:
    request_id = str(message.get("request_id") or "")
    command = str(message.get("command") or "")
    timeout_seconds = max(1, min(int(message.get("timeout_seconds") or 300), 3600))
    started = time.monotonic()
    timed_out = False
    interrupted = False
    try:
        env = _execution_environment(message, os.environ)
        process = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, start_new_session=True,
        )
        active_processes[request_id] = process

        async def pump(reader, stream: str) -> None:
            while True:
                chunk = await reader.read(MAX_CHUNK)
                if not chunk:
                    return
                await _send_json(websocket, {
                    "type": "worker.output", "request_id": request_id,
                    "stream": stream, "data": chunk.decode("utf-8", errors="replace"),
                })

        stdout_task = asyncio.create_task(pump(process.stdout, "stdout"))
        stderr_task = asyncio.create_task(pump(process.stderr, "stderr"))
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
        except TimeoutError:
            timed_out = True
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, 9)
            await process.wait()
        await asyncio.gather(stdout_task, stderr_task)
        exit_code = process.returncode
        interrupted = exit_code in (-2, 130)
    except Exception as exc:
        await _send_json(websocket, {
            "type": "worker.output", "request_id": request_id,
            "stream": "stderr", "data": f"Worker execution error: {exc}\n",
        })
        exit_code = 127
    finally:
        active_processes.pop(request_id, None)
    await _send_json(websocket, {
        "type": "worker.result", "request_id": request_id, "exit_code": exit_code,
        "timed_out": timed_out, "interrupted": interrupted,
        "duration_seconds": round(time.monotonic() - started, 3),
    })


def _fetch_oidc_token(request_url: str, request_token: str, audience: str = "utils-worker") -> str:
    if not request_url or not request_token:
        return ""
    parsed = urlsplit(request_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["audience"] = audience
    url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    request = Request(url, headers={"Authorization": f"Bearer {request_token}", "Accept": "application/json"})
    with urlopen(request, timeout=10) as response:
        payload = json.loads(response.read())
    token = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("GitHub Actions did not issue an OIDC identity token")
    return token


async def _start_git_credential_server(request_url: str, request_token: str, server_url: str, worker_id: str):
    """Keep the GitHub OIDC request credential in the agent process, not command environments."""
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            command = (await asyncio.wait_for(reader.readline(), timeout=5)).decode("ascii", errors="ignore").strip()
            if command != "get":
                writer.write(b"\n")
            else:
                token = await asyncio.to_thread(_fetch_oidc_token, request_url, request_token, "utils-git-proxy")
                writer.write((token + "\n").encode("utf-8"))
            await writer.drain()
        except Exception as exc:
            print(
                f"Git proxy OIDC credential request failed ({type(exc).__name__})",
                file=sys.stderr,
                flush=True,
            )
            writer.write(b"\n")
            with contextlib.suppress(Exception):
                await writer.drain()
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0, limit=1024)
    port = server.sockets[0].getsockname()[1]
    helper_path = os.path.join(tempfile.gettempdir(), f"utils-git-credential-{os.getpid()}")
    expected_host = urlsplit(server_url).netloc
    expected_path = f"git-proxy/{worker_id}/"
    helper_source = f"""#!/usr/bin/env python3
import socket
import sys
if len(sys.argv) > 1 and sys.argv[1] != "get":
    raise SystemExit(0)
fields = {{}}
for _line in sys.stdin:
    if not _line.strip():
        break
    _key, _sep, _value = _line.partition("=")
    if _sep:
        fields[_key] = _value.rstrip(chr(13) + chr(10))
if fields.get("protocol") != "https" or fields.get("host") != "{expected_host}" or not fields.get("path", "").startswith("{expected_path}"):
    raise SystemExit(0)
with socket.create_connection(("127.0.0.1", {port}), timeout=15) as connection:
    connection.sendall(b"get" + bytes([10]))
    token = connection.makefile("r", encoding="utf-8").readline().strip()
if not token:
    raise SystemExit(1)
print("username=worker")
print("password=" + token)
print()
"""
    descriptor = os.open(helper_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    with os.fdopen(descriptor, "w", encoding="utf-8") as helper_file:
        helper_file.write(helper_source)
    os.chmod(helper_path, 0o700)
    return server, helper_path


def _configure_git_proxy(server_url: str, worker_id: str, helper_path: str) -> None:
    proxy_prefix = f"{server_url.rstrip('/')}/git-proxy/{worker_id}/"
    subprocess.run(
        ["git", "config", "--global", f"url.{proxy_prefix}.insteadOf", "https://github.com/"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "--global", "credential.useHttpPath", "true"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "--global", "--replace-all", "credential.helper", helper_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _start_virtual_display() -> list[subprocess.Popen]:
    if os.environ.get("UTILS_WORKER_DISPLAY_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return []
    display = os.environ.get("UTILS_WORKER_DISPLAY", ":99")
    os.environ["DISPLAY"] = display
    processes: list[subprocess.Popen] = []
    commands = [
        ["Xvfb", display, "-screen", "0", "1440x900x24", "-ac", "-nolisten", "tcp", "-noreset"],
        ["openbox", "--sm-disable"],
        ["x11vnc", "-display", display, "-rfbport", "5900", "-localhost", "-nopw", "-forever", "-shared", "-noxdamage"],
    ]
    try:
        for command in commands:
            processes.append(subprocess.Popen(
                command, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                env=os.environ.copy(), start_new_session=True,
            ))
            if command[0] == "Xvfb":
                time.sleep(1)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("A virtual desktop process exited during startup")
            try:
                with socket.create_connection(("127.0.0.1", 5900), timeout=1):
                    print(f"Virtual desktop ready on {display} (VNC localhost:5900)", flush=True)
                    return processes
            except OSError:
                time.sleep(0.5)
        raise RuntimeError("Timed out waiting for the virtual desktop VNC listener")
    except Exception:
        _stop_virtual_display(processes)
        raise

def _stop_virtual_display(processes: list[subprocess.Popen]) -> None:
    for process in reversed(processes):
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
    for process in reversed(processes):
        if process.poll() is None:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()


async def _relay_display_client(websocket, client_id: str, writers: dict[str, asyncio.StreamWriter]) -> None:
    writer = None
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", 5900)
        writers[client_id] = writer
        await _send_json(websocket, {"type": "worker.display.connected", "client_id": client_id})
        while True:
            chunk = await reader.read(MAX_CHUNK)
            if not chunk:
                break
            await _send_json(websocket, {
                "type": "worker.display.frame",
                "client_id": client_id,
                "data": base64.b64encode(chunk).decode("ascii"),
            })
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await _send_json(websocket, {
            "type": "worker.display.error", "client_id": client_id,
            "error": f"{type(exc).__name__}: {exc}"[:300],
        })
    finally:
        writers.pop(client_id, None)
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


async def _connect_once(socket_url: str, server_url: str, worker_id: str, token: str, oidc_token: str, profiles_json: str, setup_json: str, setup_started: asyncio.Event, git_helper_path: str | None, display_enabled: bool) -> None:
    async with connect(socket_url, ping_interval=25, ping_timeout=25, max_size=2**20) as websocket:
        await _send_json(websocket, {"type": "worker.hello", "worker_id": worker_id, "token": token, "oidc_token": oidc_token})
        response = json.loads(await websocket.recv())
        if response.get("type") != "worker.auth.ok":
            raise RuntimeError("Utils rejected the worker connection")
        print(f"Worker {worker_id} connected to Utils", flush=True)
        if display_enabled:
            await _send_json(websocket, {"type": "worker.display.ready"})
        if response.get("git_proxy_enabled"):
            if not git_helper_path:
                raise RuntimeError("Git proxy credential helper is unavailable")
            await asyncio.to_thread(_configure_git_proxy, server_url, worker_id, git_helper_path)
            print("GitHub HTTPS proxy configured for this worker", flush=True)
        restore_errors = await receive_session_restore(websocket)
        for component, error in restore_errors.items():
            await _status(websocket, "preparing", f"Session restore failed for {component}: {error}", task_id=f"session-restore-{component}", task_name=f"Restore {component}", task_status="failed")
        active_processes: dict[str, asyncio.subprocess.Process] = {}
        display_writers: dict[str, asyncio.StreamWriter] = {}
        display_tasks: dict[str, asyncio.Task] = {}
        if not setup_started.is_set():
            setup_started.set()
            asyncio.create_task(_provision(websocket, profiles_json, setup_json, restore_errors))
        try:
            while True:
                message = json.loads(await websocket.recv())
                if message.get("type") == "worker.exec":
                    asyncio.create_task(_execute(websocket, message, active_processes))
                elif message.get("type") == "worker.session.extract":
                    asyncio.create_task(send_session_snapshot(
                        websocket, str(message.get("request_id") or ""),
                        message.get("components") or [], _send_json,
                    ))
                elif message.get("type") == "worker.display.start" and display_enabled:
                    client_id = str(message.get("client_id") or "")
                    if client_id and client_id not in display_tasks:
                        task = asyncio.create_task(_relay_display_client(websocket, client_id, display_writers))
                        display_tasks[client_id] = task
                        task.add_done_callback(lambda _task, key=client_id: display_tasks.pop(key, None))
                elif message.get("type") == "worker.display.input" and display_enabled:
                    client_id = str(message.get("client_id") or "")
                    encoded = message.get("data")
                    writer = display_writers.get(client_id)
                    if writer is not None and isinstance(encoded, str) and len(encoded) <= 100_000:
                        try:
                            chunk = base64.b64decode(encoded, validate=True)
                        except (ValueError, base64.binascii.Error):
                            continue
                        writer.write(chunk)
                        await writer.drain()
                elif message.get("type") == "worker.display.stop":
                    client_id = str(message.get("client_id") or "")
                    task = display_tasks.pop(client_id, None)
                    if task:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                elif message.get("type") == "worker.cancel":
                    request_id = str(message.get("request_id") or "")
                    process = active_processes.get(request_id)
                    if process is not None and process.returncode is None:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(process.pid, 2)
                        async def force_stop(proc: asyncio.subprocess.Process) -> None:
                            await asyncio.sleep(5)
                            if proc.returncode is None:
                                with contextlib.suppress(ProcessLookupError):
                                    os.killpg(proc.pid, 15)
                                await asyncio.sleep(2)
                            if proc.returncode is None:
                                with contextlib.suppress(ProcessLookupError):
                                    os.killpg(proc.pid, 9)
                        asyncio.create_task(force_stop(process))
        finally:
            tasks_to_stop = list(display_tasks.values())
            for task in tasks_to_stop:
                task.cancel()
            if tasks_to_stop:
                await asyncio.gather(*tasks_to_stop, return_exceptions=True)
            writers_to_close = list(display_writers.values())
            for writer in writers_to_close:
                writer.close()
            if writers_to_close:
                await asyncio.gather(*(writer.wait_closed() for writer in writers_to_close), return_exceptions=True)


async def run() -> None:
    worker_id = os.environ.get("UTILS_WORKER_ID", "").strip()
    server_url = os.environ.get("UTILS_WORKER_SERVER_URL", "").strip()
    token = os.environ.get("UTILS_WORKER_TOKEN", "")
    oidc_request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    oidc_request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    os.environ.pop("UTILS_WORKER_TOKEN", None)
    os.environ.pop("ACTIONS_ID_TOKEN_REQUEST_TOKEN", None)
    profiles_json = os.environ.get("UTILS_WORKER_PROFILES", '["minimal"]')
    setup_json = os.environ.get("UTILS_WORKER_CUSTOM_SETUP", "{}")
    display_enabled = os.environ.get("UTILS_WORKER_DISPLAY_ENABLED", "false").lower() in {"1", "true", "yes"}
    if not worker_id or not token or not server_url:
        raise RuntimeError("UTILS_WORKER_ID, UTILS_WORKER_SERVER_URL and UTILS_WORKER_TOKEN are required")
    parsed = urlsplit(server_url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RuntimeError("UTILS_WORKER_SERVER_URL must be an HTTP(S) origin")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    socket_url = f"{scheme}://{parsed.netloc}/github-workers/agent"
    delay = 2
    setup_started = asyncio.Event()
    display_processes = await asyncio.to_thread(_start_virtual_display) if display_enabled else []
    if display_processes:
        atexit.register(_stop_virtual_display, display_processes)
        def stop_display_on_signal(signum, _frame):
            _stop_virtual_display(display_processes)
            raise SystemExit(128 + signum)
        signal.signal(signal.SIGTERM, stop_display_on_signal)
    git_credential_server = None
    git_helper_path = None
    if oidc_request_url and oidc_request_token:
        git_credential_server, git_helper_path = await _start_git_credential_server(oidc_request_url, oidc_request_token, server_url, worker_id)
    while True:
        try:
            oidc_token = await asyncio.to_thread(_fetch_oidc_token, oidc_request_url, oidc_request_token) if oidc_request_url and oidc_request_token else ""
            await _connect_once(socket_url, server_url, worker_id, token, oidc_token, profiles_json, setup_json, setup_started, git_helper_path, display_enabled)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            setup_started.clear()
            print(f"Worker connection interrupted ({type(exc).__name__}); reconnecting in {delay}s", flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
        else:
            delay = 2


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
