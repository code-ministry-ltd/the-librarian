# Usage-stats receiver

The Cloudflare Worker that receives The Librarian's anonymous weekly pings (spec 085). It
stores one row per install per ISO week, keeps no IP address, headers or exact times, deletes
rows after about 13 months, and serves public aggregates at `GET /v1/stats`.

What a server sends, and when, is defined in `packages/mcp-server/src/telemetry.ts` and shown
to every operator on Settings → Telemetry. `src/ping.ts` rejects anything that isn't exactly
that shape.

## Deploy

You need a Cloudflare account with `codeministry.net` on it, and `wrangler` logged in
(`npx wrangler login`).

```sh
cd services/telemetry-worker
npx wrangler d1 create librarian-telemetry        # copy the database_id into wrangler.toml
npx wrangler d1 execute librarian-telemetry --remote --file=schema.sql
npx wrangler deploy
```

`wrangler deploy` attaches the custom domain `librarian-telemetry.codeministry.net` from
`wrangler.toml`. Check it with:

```sh
curl -s https://librarian-telemetry.codeministry.net/v1/stats
```

Until this is deployed, servers' pings fail quietly and are retried on the next hourly check.
Nothing is queued or stored on the servers' side apart from the last successful payload.

## Testing a server against a local receiver

```sh
npx wrangler dev                                   # serves on http://localhost:8787
LIBRARIAN_TELEMETRY_URL=http://localhost:8787/v1/ping pnpm dev
```
