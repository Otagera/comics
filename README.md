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

Push to `main` and GitHub Actions does it: run tests, build the image, push it
to GHCR, then SSH to the host to pull and restart. The host never builds --
its root disk has no room for a layer cache, so CI carries that cost and the
host only pulls a finished image.

Each deploy pins `SIDECAR_IMAGE` in the host's `.env` to the commit's image
tag, so the running container is always traceable to a commit and a rollback
is one `SIDECAR_IMAGE=ghcr.io/<owner>/comics-sidecar:<sha>` away.

Repository secrets:

| secret | value |
| --- | --- |
| `DEPLOY_HOST` | host address |
| `DEPLOY_USER` | ssh user |
| `DEPLOY_PATH` | deploy directory, e.g. `/mnt/HC_Volume_106816620/comics-stack` |
| `DEPLOY_SSH_KEY` | private half of a key in the host's `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | optional; pins the host key instead of trust-on-first-use |

Only `docker-compose.yml` is copied to the host. `.env` and `logs/` live there
and are never overwritten; the application itself ships inside the image.

Deploying by hand still works -- sync the repo and run `up -d --build`.

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
