# Interactive VM tool surface

The worker runs a single persistent Ubuntu GitHub Actions environment. The desktop, shared Chromium browser, shell, filesystem, and process controls operate on that same runner.

Utils exposes the VM controls as authenticated MCP tools:

- `vm_status`
- `vm_exec`
- `vm_read_file`
- `vm_write_file`
- `vm_list_files`
- `vm_search_files`
- `vm_processes`
- `vm_kill_process`
- `vm_screenshot`
- `vm_open_url`
- `vm_restore_browser`
- `vm_install_package`

The existing Playwright MCP browser tools continue to operate against the same headed Chromium instance over CDP. VNC displays the same X11 desktop.
