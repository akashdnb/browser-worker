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
