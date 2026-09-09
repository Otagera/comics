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

Updating: sync the repo to the deploy directory and re-run `up -d --build`.
`.env` and `logs/` live only on the host and are never overwritten.

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
