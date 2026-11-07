from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from urllib.parse import urlsplit

from websockets.asyncio.client import connect

from session_agent import send_session_snapshot

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


async def _provision(websocket, profiles_json: str, setup_json: str) -> None:
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
        if failed:
            overall = "partially_ready" if completed else "failed"
            summary = f"Environment setup finished: {len(completed)} completed, {len(failed)} failed or skipped"
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
            elif message.get("type") == "worker.session.extract":
                asyncio.create_task(send_session_snapshot(
                    websocket, str(message.get("request_id") or ""),
                    message.get("components") or [], _send_json,
                ))
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
