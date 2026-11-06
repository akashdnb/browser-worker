from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from urllib.parse import urlsplit

from websockets.asyncio.client import connect

MAX_CHUNK = 16_384
SETUP_REQUEST_ID = "environment-setup"


async def _send_json(websocket, payload: dict) -> None:
    await websocket.send(json.dumps(payload))


async def _status(websocket, status: str, message: str) -> None:
    await _send_json(websocket, {"type": "worker.status", "environment_status": status, "message": message})


async def _stream_process(websocket, command: list[str] | str, *, shell: bool = False, timeout: int = 600) -> None:
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
                "type": "worker.output", "request_id": SETUP_REQUEST_ID,
                "stream": "stdout", "data": chunk.decode("utf-8", errors="replace"),
            })

    pump_task = asyncio.create_task(pump())
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, 9)
        await process.wait()
        raise RuntimeError(f"Setup command timed out after {timeout}s: {command}")
    await pump_task
    if process.returncode:
        raise RuntimeError(f"Setup command failed with exit code {process.returncode}: {command}")


async def _provision(websocket, profiles_json: str, setup_json: str) -> None:
    try:
        profiles = json.loads(profiles_json or '["minimal"]')
        setup = json.loads(setup_json or "{}")
        allowed_profiles = {"minimal", "python", "node", "playwright-chromium", "devops"}
        allowed_setup = {"apt_packages", "pip_packages", "npm_packages", "commands"}
        if (not isinstance(profiles, list) or not profiles
                or any(profile not in allowed_profiles for profile in profiles)
                or not isinstance(setup, dict) or set(setup) - allowed_setup):
            raise RuntimeError("Invalid environment configuration")

        apt = list(setup.get("apt_packages", []))
        if "devops" in profiles:
            apt += ["jq", "yq", "ripgrep", "shellcheck"]
        if apt:
            await _status(websocket, "preparing", "Updating package indexes")
            await _stream_process(websocket, ["sudo", "apt-get", "update"], timeout=300)
            await _status(websocket, "preparing", "Installing system packages")
            await _stream_process(websocket, ["sudo", "apt-get", "install", "-y", "--no-install-recommends", *dict.fromkeys(apt)], timeout=600)

        pip = list(setup.get("pip_packages", []))
        if "playwright-chromium" in profiles:
            pip += ["playwright"]
        if pip:
            await _status(websocket, "preparing", "Installing Python packages")
            await _stream_process(websocket, ["python", "-m", "pip", "install", "--disable-pip-version-check", *dict.fromkeys(pip)], timeout=600)
        if "playwright-chromium" in profiles:
            await _status(websocket, "preparing", "Installing Playwright Chromium")
            await _stream_process(websocket, ["python", "-m", "playwright", "install", "--with-deps", "chromium"], timeout=900)

        npm = list(setup.get("npm_packages", []))
        if npm:
            await _status(websocket, "preparing", "Installing global npm packages")
            await _stream_process(websocket, ["npm", "install", "--global", *dict.fromkeys(npm)], timeout=600)
        for index, command in enumerate(setup.get("commands", []), start=1):
            await _status(websocket, "preparing", f"Running custom setup command {index}")
            await _stream_process(websocket, command, shell=True, timeout=600)

        await _status(websocket, "ready", "Environment is ready")
    except Exception as exc:
        with contextlib.suppress(Exception):
            await _send_json(websocket, {
                "type": "worker.output", "request_id": SETUP_REQUEST_ID,
                "stream": "stderr", "data": f"Environment setup failed: {exc}\n",
            })
            await _status(websocket, "failed", str(exc)[:500])


async def _execute(websocket, message: dict, active_processes: dict) -> None:
    request_id = str(message.get("request_id") or "")
    command = str(message.get("command") or "")
    timeout_seconds = max(1, min(int(message.get("timeout_seconds") or 300), 3600))
    started = time.monotonic()
    timed_out = False
    interrupted = False
    env = os.environ.copy()
    env.pop("UTILS_WORKER_TOKEN", None)
    try:
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


async def _connect_once(socket_url: str, worker_id: str, token: str, profiles_json: str, setup_json: str, setup_started: asyncio.Event) -> None:
    async with connect(socket_url, ping_interval=25, ping_timeout=25, max_size=2**20) as websocket:
        await _send_json(websocket, {"type": "worker.hello", "worker_id": worker_id, "token": token})
        response = json.loads(await websocket.recv())
        if response.get("type") != "worker.auth.ok":
            raise RuntimeError("Utils rejected the worker connection")
        print(f"Worker {worker_id} connected to Utils", flush=True)
        active_processes: dict[str, asyncio.subprocess.Process] = {}
        if not setup_started.is_set():
            setup_started.set()
            asyncio.create_task(_provision(websocket, profiles_json, setup_json))
        while True:
            message = json.loads(await websocket.recv())
            if message.get("type") == "worker.exec":
                asyncio.create_task(_execute(websocket, message, active_processes))
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


async def run() -> None:
    worker_id = os.environ.get("UTILS_WORKER_ID", "").strip()
    server_url = os.environ.get("UTILS_WORKER_SERVER_URL", "").strip()
    token = os.environ.get("UTILS_WORKER_TOKEN", "")
    profiles_json = os.environ.get("UTILS_WORKER_PROFILES", '["minimal"]')
    setup_json = os.environ.get("UTILS_WORKER_CUSTOM_SETUP", "{}")
    if not worker_id or not token or not server_url:
        raise RuntimeError("UTILS_WORKER_ID, UTILS_WORKER_SERVER_URL and UTILS_WORKER_TOKEN are required")
    parsed = urlsplit(server_url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RuntimeError("UTILS_WORKER_SERVER_URL must be an HTTP(S) origin")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    socket_url = f"{scheme}://{parsed.netloc}/github-workers/agent"
    delay = 2
    setup_started = asyncio.Event()
    while True:
        try:
            await _connect_once(socket_url, worker_id, token, profiles_json, setup_json, setup_started)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"Worker connection interrupted ({type(exc).__name__}); reconnecting in {delay}s", flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
        else:
            delay = 2


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
