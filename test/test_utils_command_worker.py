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
