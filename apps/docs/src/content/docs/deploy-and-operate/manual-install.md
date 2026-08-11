---
title: Manual deployment
description: Run The Librarian by hand with Docker — single container, Compose, or Fly.io.
---

The [one-command self-host](/deploy-and-operate/self-host/) path covers most people.
This page is for operators who want to drive Docker themselves: the published
all-in-one image, image-only Compose, the source-build Compose stack, or Fly.io.

The managed CLI path is deliberately stricter than these manual examples: stable
`server up` and `server update` never use `latest`. They select an exact `vX.Y.Z`,
match its source commit to the GitHub tag and its digest to the release receipt,
and run the immutable digest. See [Self-host](/deploy-and-operate/self-host/) for
its pull, provenance, and update-recovery contract.

## Single container (manual)

One public image runs both services (the MCP server and the dashboard) under a
small supervisor. Pull `latest` for a quick first run; for a durable deployment,
replace it with a release tag such as `v1.20.1` and keep that tag in your
configuration:

```sh
docker pull ghcr.io/code-ministry-ltd/the-librarian:latest
umask 077
printf 'LIBRARIAN_AGENT_TOKEN=%s\nLIBRARIAN_SECRET_KEY=%s\n' \
  "$(openssl rand -base64 48)" "$(openssl rand -hex 32)" > librarian.env
docker run -d --name the-librarian \
  --restart unless-stopped \
  -p 127.0.0.1:3042:3000 -p 127.0.0.1:3838:3838 \
  -v librarian_data:/data \
  --env-file librarian.env \
  ghcr.io/code-ministry-ltd/the-librarian:latest
```

Key points:

- The dashboard is at `http://<host>:3042` (the host side of `-p 3042:3000` —
  the container always listens on 3000 internally); the MCP endpoint is
  `http://<host>:3838/mcp`.
- `/data` is your vault and settings — **back it up** (see
  [Backups & restore](/guides/backups-restore/)). It must be writable by the image's
  user (UID 1000); on platforms that mount volumes root-owned, `chown` it.
- Keep `librarian.env` mode `0600`, back it up securely, and read its agent token
  when connecting clients. Docker stores container environment values in its own
  metadata too, so restrict access to the Docker daemon.
- **There is no admin token.** The admin API runs only on an internal listener inside
  the container; the published port carries only the agent surface, gated by
  `LIBRARIAN_AGENT_TOKEN`. (More on this model in
  [Authentication & secrets](/deploy-and-operate/auth-and-secrets/).)
- **The master key auto-generates if unset.** On first boot the server writes it to
  `/data/secret.key` and logs it **once** — copy it somewhere safe. Supplying it via
  the environment (as above) is the recommended posture, because an env-supplied key
  is never written to the data volume. A 32-byte hex key (`openssl rand -hex 32`) is
  what the secret key wants — not the base64 value used for tokens.
- Put the published port behind **TLS** on any host reachable beyond loopback, and do
  not set `LIBRARIAN_ALLOW_NO_AUTH=true` on a publicly reachable host.
- The image crash-fasts if either service dies, so your orchestrator restarts the
  pair.

## Image-only Compose (recommended manual path)

This path needs Docker Compose but no source checkout or local image build. Download
the deployment files, protect the env file, and replace both credential placeholders:

```sh
mkdir the-librarian && cd the-librarian
curl -fsSLO https://raw.githubusercontent.com/code-ministry-ltd/the-librarian/main/docker/docker-compose.image.yml
curl -fsSLO https://raw.githubusercontent.com/code-ministry-ltd/the-librarian/main/docker/all-in-one.env.example
cp all-in-one.env.example .env
chmod 0600 .env
```

Generate an agent token with `openssl rand -base64 48` and a master key with
`openssl rand -hex 32`, then put their outputs in `.env`. Keep `latest` for the
first run or set `LIBRARIAN_VERSION=vX.Y.Z` to pin a release. Render the
configuration without printing its interpolated credentials, then start it:

```sh
docker compose --env-file .env -f docker-compose.image.yml config --quiet
docker compose --env-file .env -f docker-compose.image.yml up -d

curl http://127.0.0.1:3838/healthz
curl http://127.0.0.1:3042/api/health
```

Both ports bind to loopback by default. If clients connect over a private network,
set the two `*_PUBLISHED_HOST` values in `.env`; if the dashboard is reachable
beyond loopback, terminate TLS in front of it and treat network access as admin
access. The default named volume is `librarian_data`. For a bind mount, set
`LIBRARIAN_DATA_SOURCE` to an absolute host path and set `LIBRARIAN_DATA_UID` /
`LIBRARIAN_DATA_GID` to its owner.

Use exact version tags for controlled upgrades and rollbacks:

```sh
# Edit LIBRARIAN_VERSION in .env, then:
docker compose --env-file .env -f docker-compose.image.yml pull
docker compose --env-file .env -f docker-compose.image.yml up -d
```

To roll back, put the previous `vX.Y.Z` in `.env` and run the same two commands.
The data volume is preserved. Run bundled admin commands directly in the container,
for example `docker compose --env-file .env -f docker-compose.image.yml exec
the-librarian the-librarian backup`. Do not use `docker compose down -v` unless
you intend to delete the vault.

### Fly.io

A starter `fly.toml` is included. It enables single-port mode on Fly's HTTPS
dashboard service. Edit `app`, `primary_region`, and `LIBRARIAN_PUBLIC_URL` together,
then configure the agent token and the browser origins:

```sh
fly volumes create librarian_data --size 1
fly secrets set \
  LIBRARIAN_AGENT_TOKEN=… \
  LIBRARIAN_SECRET_KEY=… \
  LIBRARIAN_ALLOWED_ORIGINS=https://your-app.fly.dev,chrome-extension://<extension-id>
fly deploy
```

The starter temporarily leaves TLS port 3838 published for existing clients. Point
clients at `https://your-app.fly.dev/mcp`, migrate them, then remove the
`[[services]]` block from `fly.toml` so 443 is the only public port. The admin tRPC
listener is never published.

## One published port

Single-port mode keeps the MCP server on its internal listener and proxies its public
agent routes through the dashboard. A reverse proxy or hosting platform then needs
to expose only the dashboard listener:

- `GET /healthz` and `GET /primer.md` remain public, matching the MCP listener.
- `/mcp`, `/transcript`, and `/ingest` require the same bearer tokens and origin
  checks as direct port 3838 traffic. Dashboard cookies are stripped.
- The dashboard refuses those three protected routes if the MCP server is running
  without agent authentication. Set `LIBRARIAN_AGENT_TOKEN` or
  `LIBRARIAN_AGENT_TOKENS`, and do not set `LIBRARIAN_ALLOW_NO_AUTH=true`.

All four deployment settings matter:

```sh
LIBRARIAN_SINGLE_PORT=true
LIBRARIAN_PUBLIC_URL=https://memory.example.com
LIBRARIAN_ALLOWED_ORIGINS=https://memory.example.com,chrome-extension://<extension-id>
LIBRARIAN_AGENT_TOKEN=<long-random-agent-token>
```

`LIBRARIAN_PUBLIC_URL` keeps the Connect page on
`https://memory.example.com/mcp` instead of advertising port 3838. The origin list
must contain both entries: once a non-empty allow-list exists, the capture
extension's scheme is no longer admitted automatically.

For the all-in-one image, publish only the dashboard port and put it behind TLS:

```sh
docker run -d --name the-librarian \
  -p 127.0.0.1:3042:3000 \
  -v librarian_data:/data \
  -e LIBRARIAN_SINGLE_PORT=true \
  -e LIBRARIAN_PUBLIC_URL=https://memory.example.com \
  -e LIBRARIAN_ALLOWED_ORIGINS=https://memory.example.com,chrome-extension://<extension-id> \
  -e LIBRARIAN_AGENT_TOKEN=<long-random-agent-token> \
  -e LIBRARIAN_SECRET_KEY=<64-hex-master-key> \
  ghcr.io/code-ministry-ltd/the-librarian:vX.Y.Z
```

Terminate HTTPS at the reverse proxy and forward the public origin to container port
3000. Do not publish container port 3838. For image-only Compose, put the four
values above in `.env` and remove the MCP port mapping from
`docker-compose.image.yml`, then expose only dashboard port 3042 through TLS. For
the source-build stack below, remove the `mcp-server` service's `ports:` mapping
(or keep its default loopback-only binding during migration) and expose only
dashboard port 3839.

## Two-container Compose stack (advanced)

The Compose stack runs two Node services — `mcp-server` (the agent surface on the
published port 3838, plus the admin API on a separate **unpublished** internal port)
and `dashboard` (the Next.js admin UI on port 3000) — sharing one named volume.

Copy the repository to your host, create an env file, and set an agent token (the one
network credential):

```sh
cp .env.example .env
openssl rand -base64 48              # generate an agent token
```

Put it in `.env`:

```sh
LIBRARIAN_AGENT_TOKEN=<long-random-agent-token>
```

There is **no admin token** to set. The master key (`LIBRARIAN_SECRET_KEY`) is
optional — it auto-generates if unset; set it to keep the key off the data volume.
If you want each agent's writes attributed to a distinct identity, use per-agent
tokens:

```sh
LIBRARIAN_AGENT_TOKENS=codex:<token-a>,claude:<token-b>
```

By default both services bind to `127.0.0.1` only. For tailnet access, set the
published hosts:

```sh
LIBRARIAN_MCP_PUBLISHED_HOST=100.x.y.z
LIBRARIAN_DASHBOARD_PUBLISHED_HOST=100.x.y.z
```

Build and start, then verify:

```sh
docker compose --env-file .env -f docker/docker-compose.yml up -d --build

curl http://100.x.y.z:3838/healthz
curl http://100.x.y.z:3839/health
```

(If the dashboard health check fails the first time, give it ~15 seconds — Next.js
cold-boots slower than the MCP server. If you see `permission denied` under `/data`,
stop the stack, `chown -R 1000:1000` the volume's data directory, and start again.)

## Endpoints

- **Dashboard:** `http://<host>:3042/` (single-container default; the Compose
  stack above publishes it on `:3839` instead)
- **MCP endpoint (`/mcp`):** `http://<host>:3838/mcp` — agents POST JSON-RPC here with an
  `Authorization: Bearer <token>` header. The server offers no standalone server-push SSE
  stream, so authenticated GET probes receive `405 Method Not Allowed`.
- **Healthcheck (`/healthz`):** `http://<host>:3838/healthz`
- **Primer (`/primer.md`):** `http://<host>:3838/primer.md` — the agent briefing, served **without
  authentication** by design so tools like OpenCode can load it from a URL. It is the
  only unauthenticated route; keep the briefing generic (never secret) content.
- **Transcript (`/transcript`) and capture (`/ingest`):** protected agent routes used
  by the harness integrations and browser capture extension.

Treat dashboard network access as admin access, and keep the published host on a
private network. If you front the dashboard with a reverse proxy on another hostname,
add that exact origin to `LIBRARIAN_ALLOWED_ORIGINS`.

## Source-build Compose operations

```sh
# View logs
docker compose --env-file .env -f docker/docker-compose.yml logs -f

# Upgrade
git pull
docker compose --env-file .env -f docker/docker-compose.yml up -d --build

# Stop
docker compose --env-file .env -f docker/docker-compose.yml down
```

Keep the data volume on local disk, not NFS or another unreliable network
filesystem, and push vault backups off-server. Stopping with `down -v` **wipes the
data volume** — only do that when you mean to destroy everything.
