# SKTOnline home metadata resolver

This service is intentionally **metadata-only**. It fetches SKTOnline search/player HTML from a residential/CZ connection and returns video IDs and final media URLs. Video bytes are never proxied through this service.

## Run on the home Raspberry Pi / server

Use the same repository checkout as the addon, or clone it once:

```bash
git clone https://github.com/CaseyCZ/stremio.sktonline.git
cd stremio.sktonline
npm install
```

Generate a private token and keep it outside Git:

```bash
openssl rand -hex 32
```

Start with PM2 (replace the token value):

```bash
export SKTONLINE_RESOLVER_TOKEN='PASTE_RANDOM_TOKEN_HERE'
pm2 start resolver/ecosystem.config.js --update-env
pm2 save
curl http://127.0.0.1:7010/health
```

The resolver listens only on `127.0.0.1:7010`, so expose it through a private/restricted tunnel (for example a named Cloudflare Tunnel) rather than opening the port on the router.

The Oracle addon then needs these environment variables:

```bash
SKTONLINE_RESOLVER_URL=https://your-resolver-hostname.example
SKTONLINE_RESOLVER_TOKEN=the_same_random_token
```

After setting them, reload `stremio-sktonline` with PM2.

## Endpoints

- `GET /health` — no token, service status only.
- `POST /v1/search` — Bearer token required; searches `online.sktorrent.eu` by title.
- `POST /v1/resolve` — Bearer token required; resolves only `online.sktorrent.eu` / `onlineN.sktorrent.eu` pages.

The resolver rejects arbitrary target hosts, so it is not a general-purpose proxy.
