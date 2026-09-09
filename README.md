# Comics

Komga plus a Drive-backed catalogue sidecar, deployed as one compose stack.

- **Komga** serves and reads the library.
- **The sidecar** (`comics.otagera.xyz`) catalogues the Google Drive archive,
  tracks reading, holds a wishlist, and decides what is cached on disk.

Google Drive is the source of truth; the local volume is a cache over it. The
sidecar does not read comics, does not manage metadata, and does not track
books or articles — Komga owns reading and metadata.

## Deploy

One compose file, both services, domains assigned at deploy time.

```sh
cp .env.example .env      # fill in domains, volume root, Komga key, auth hash
docker compose up -d --build
```

Both domains must resolve to the host with proxying **off** (grey cloud in
Cloudflare): the certificate resolver uses an HTTP-01 challenge.

### Continuous deployment

Coolify owns the deployment. Push to `main` and GitHub Actions runs the tests,
builds the sidecar image, pushes it to GHCR, then calls Coolify's deploy
webhook. Coolify pulls the new image, restarts the stack, and keeps the logs.
CI never touches the host directly -- if it deployed as well, the two would
fight over the same containers.

Repository secrets:

| secret | value |
| --- | --- |
| `COOLIFY_WEBHOOK_URL` | `https://<coolify-host>/api/v1/deploy?uuid=<resource-uuid>&force=false` — the **API** endpoint, called with **POST** (Coolify 4.3.x moved it from GET; older docs and examples still show GET) |
| `COOLIFY_TOKEN` | a Coolify API token with **deploy** permission, in the same team as the resource (Keys & Tokens -> API tokens). A token without it returns 403; an unaccepted one returns 401 |

One-time setup in Coolify:

1. New Resource -> **Docker Compose**, pointed at this repository.
2. Environment variables: everything in `.env.example`. Set
   `SIDECAR_IMAGE=ghcr.io/<owner>/comics-sidecar:latest`.
3. Leave every **domain field empty**. Routing comes from the Traefik labels in
   `docker-compose.yml`, because the sidecar's basic-auth middleware has to sit
   on the same router that serves it. A domain set in Coolify makes Coolify
   generate a second router for the same host, and the one Traefik picks may
   carry no auth at all -- the site would serve wide open and look healthy.
4. If the GHCR package is private, add registry credentials so Coolify can
   pull; making the package public is simpler for a public repo.

Rolling back: point `SIDECAR_IMAGE` at a commit tag
(`ghcr.io/<owner>/comics-sidecar:<sha>`) and redeploy.

**Verify after the first Coolify deploy**, because `$` in an environment
variable is the one thing that reliably breaks here -- the basic-auth hash
contains `$apr1$...`, and a layer that interpolates it silently produces a
hash that authenticates nobody:

```sh
# the applied label must show single dollars, matching the htpasswd line
docker inspect "$(docker ps -q --filter label=vault.role=sidecar)" \
  --format '{{index .Config.Labels "traefik.http.middlewares.comics-auth.basicauth.users"}}'

# and the domain must actually challenge
curl -s -o /dev/null -w '%{http_code}\n' https://comics.otagera.xyz/   # want 401
```

## Maintenance

Runs hourly from cron; also runnable by hand:

```sh
docker exec comics-sidecar node --experimental-strip-types \
  /app/src/server/cli.ts <index|reconcile|sync|evict|maintenance|status|list|fetch>
```

`maintenance` runs index → reconcile → sync → evict, in that order: refresh the
catalogue, make cache state follow the disk, learn what has been read, then use
that fresh reading state to decide what to drop.

## Development

```sh
npm install
npm run dev
npm test
```

The maintenance CLI imports only `node:` builtins and sibling modules, so it
runs straight from TypeScript source with Node's type stripping and needs no
`node_modules` in the runtime image.
