import asyncio
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import importlib.util

MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "utils-command-worker.py"
SPEC = importlib.util.spec_from_file_location("utils_command_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(worker)


class VirtualDisplayTests(unittest.TestCase):
    def test_display_is_disabled_by_default(self):
        with patch.dict(worker.os.environ, {}, clear=True):
            self.assertEqual(worker._start_virtual_display(), [])

    def test_display_chromium_uses_playwright_binary_and_local_cdp(self):
        process = subprocess.CompletedProcess(args=[], returncode=0, stdout="/cache/ms-playwright/chromium/chrome\n", stderr="")
        child = type("Child", (), {"poll": lambda self: None})()
        with (
            patch.object(worker, "_playwright_chromium_executable", return_value=process.stdout.strip()),
            patch.object(worker.subprocess, "Popen", return_value=child) as popen,
            patch.object(worker.socket, "create_connection") as connect,
            patch.object(worker.os, "makedirs"),
            patch.dict(worker.os.environ, {"UTILS_WORKER_DISPLAY": ":99"}, clear=True),
        ):
            processes = []
            self.assertIs(worker._start_display_chromium(processes), child)
        self.assertEqual(processes, [child])
        command = popen.call_args.args[0]
        self.assertIn("--remote-debugging-address=127.0.0.1", command)
        self.assertIn("--remote-debugging-port=9222", command)
        self.assertTrue(any(item.startswith("--user-data-dir=") for item in command))
        self.assertEqual(connect.call_args.args[0], ("127.0.0.1", 9222))

    def test_display_chromium_is_not_duplicated_when_already_running(self):
        child = type("Child", (), {"poll": lambda self: None})()
        with patch.object(worker, "_start_display_chromium") as launch:
            previous = worker._DISPLAY_CHROMIUM_PROCESS
            try:
                worker._DISPLAY_CHROMIUM_PROCESS = child
                self.assertIs(worker._ensure_display_chromium([]), child)
                launch.assert_not_called()
            finally:
                worker._DISPLAY_CHROMIUM_PROCESS = previous


class WorkerExecutionEnvironmentTests(unittest.TestCase):
    def test_injects_only_short_lived_youtube_credentials(self):
        env = worker._execution_environment(
            {"environment": {
                "UTILS_YOUTUBE_ACCESS_TOKEN": "temporary-access-token",
                "UTILS_YOUTUBE_GRANTED_SCOPES": "https://www.googleapis.com/auth/youtube.upload",
            }},
            {
                "PATH": "/usr/bin",
                "UTILS_WORKER_TOKEN": "worker-secret",
                "UTILS_WORKER_AUTH_TOKEN": "worker-auth-secret",
            },
        )
        self.assertEqual(env["UTILS_YOUTUBE_ACCESS_TOKEN"], "temporary-access-token")
        self.assertNotIn("UTILS_WORKER_TOKEN", env)
        self.assertNotIn("UTILS_WORKER_AUTH_TOKEN", env)

    def test_rejects_arbitrary_or_invalid_environment_values(self):
        with self.assertRaisesRegex(ValueError, "unapproved"):
            worker._execution_environment({"environment": {"PATH": "/tmp"}}, {})
        with self.assertRaisesRegex(ValueError, "invalid"):
            worker._execution_environment(
                {"environment": {"UTILS_YOUTUBE_ACCESS_TOKEN": "x" * 8193}}, {}
            )


class GitCredentialHelperTests(unittest.TestCase):
    def test_helper_requests_oidc_token_and_returns_git_credentials(self):
        async def run_test():
            with patch.object(worker, "_fetch_oidc_token", return_value="test-oidc-token") as fetch:
                server, helper_path = await worker._start_git_credential_server(
                    "https://actions.example/oidc?api-version=2", "request-bearer",
                    "https://utils.example", "wk_test123",
                )
                try:
                    result = await asyncio.to_thread(
                        subprocess.run,
                        [helper_path, "get"],
                        input=(
                            "protocol=https\n"
                            "host=utils.example\n"
                            "path=git-proxy/wk_test123/owner/repo.git\n\n"
                        ),
                        text=True,
                        capture_output=True,
                        check=False,
                        timeout=2,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(
                        result.stdout,
                        "username=worker\npassword=test-oidc-token\n\n",
                    )
                    fetch.assert_called_once_with(
                        "https://actions.example/oidc?api-version=2",
                        "request-bearer",
                        "utils-git-proxy",
                    )
                finally:
                    server.close()
                    await server.wait_closed()
                    Path(helper_path).unlink(missing_ok=True)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
