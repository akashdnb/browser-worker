import json
import tarfile
from pathlib import Path

from session_agent import _package_inventory, extract_session_components


def test_package_inventory_is_json_and_contains_package_groups():
    result = json.loads(_package_inventory())
    assert set(result["packages"]) == {"apt", "pip", "npm"}
    assert "runtime" in result


def test_extract_rejects_unsupported_component():
    import pytest
    with pytest.raises(ValueError, match="unsupported"):
        extract_session_components(["environment"])


def test_browser_capture_reports_missing_profile(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("BROWSER_WORKER_PROFILE_DIR", raising=False)
    captured, errors = extract_session_components(["browser"])
    assert "browser" not in captured
    assert "browser" in errors


def test_tar_filter_excludes_git_and_node_modules():
    from session_agent import _safe_tar_info
    import tarfile
    assert _safe_tar_info(tarfile.TarInfo("project/.git/config")) is None
    assert _safe_tar_info(tarfile.TarInfo("project/node_modules/pkg/index.js")) is None
