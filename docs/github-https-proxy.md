# Utils GitHub HTTPS proxy integration

The Utils command worker can transparently route GitHub HTTPS remotes through the Utils Git proxy.

When the Utils WebSocket handshake advertises `git_proxy_enabled`, the worker:

1. Starts a loopback-only credential service inside the worker agent.
2. Keeps the GitHub Actions OIDC request credential in the agent process.
3. Installs a Git credential helper that asks the loopback service for a fresh OIDC token with audience `utils-git-proxy`.
4. Rewrites `https://github.com/` remotes to the worker-specific Utils `/git-proxy/{worker_id}/` endpoint.
5. Returns the OIDC token only for the configured Utils host and worker-specific proxy path.

The credential helper does not persist a GitHub installation token. Utils validates the OIDC identity and enforces the repository allowlist before minting a repository- and Contents-permission-scoped GitHub App installation token.

The loopback credential service is bound to `127.0.0.1`; the OIDC request credential is removed from the worker process environment before user commands are launched. The worker's normal GitHub Actions token remains scoped to the worker-host repository.

This worker-side change requires the matching Utils proxy implementation to be deployed. GitHub LFS is not currently routed through this integration.
