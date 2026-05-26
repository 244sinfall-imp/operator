# bes-operator

`bes-operator` is a two-part operator surface for a host-native OpenClaw/Bes setup:

- `operator-agent`: a host-side file API with strict allowlisted roots
- `operator-web`: a cluster-friendly web UI that proxies browser requests to the host agent

The first release focuses on a mobile-friendly filesystem UI:

- browse allowlisted roots
- read text files
- edit files with diff preview
- search with `rg`
- move deleted files into trash instead of removing them
- app-level password login with signed session cookie

## Architecture

The web UI is safe to expose behind Kubernetes ingress and TLS.

The host still owns the real state:

- `~/.openclaw`
- workspace repos
- local configs

`operator-agent` runs on the host and exposes a narrow REST API. `operator-web` calls it with a shared token. The browser never talks to the host directly.

## Apps

- `apps/operator-agent`
- `apps/operator-web`

## Local build

```bash
npm install
npm run build
```

## Host agent env

See [deploy/systemd/bes-operator-agent.env.example](deploy/systemd/bes-operator-agent.env.example).

Important variables:

- `OPERATOR_TOKEN`
- `OPERATOR_ALLOWED_ROOTS`
- `OPERATOR_BIND_HOST`
- `OPERATOR_PORT`

## Cluster web env

- `AGENT_BASE_URL`
- `AGENT_SHARED_TOKEN`
- `PORT`
- `OPERATOR_UI_PASSWORD_HASH` (`scrypt$salt$hexhash`)
- `OPERATOR_SESSION_SECRET`

## Safety model

- every requested path is normalized and checked against an allowlist
- symlink escapes are blocked by resolving existing paths through `realpath`
- writes require the caller to send the last seen file hash
- delete flows move files into trash
- large or binary files are not opened in the editor
