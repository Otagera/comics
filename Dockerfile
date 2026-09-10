# Comics sidecar.
#
# Two things ship in the runtime image:
#   - .output       the Nitro-bundled server (what serves comics.otagera.xyz)
#   - src/server    the TypeScript source, run directly by the maintenance CLI
#
# The CLI imports only node: builtins and sibling modules, so Node's type
# stripping runs it with no node_modules present. rclone is installed because
# the sidecar shells out to it to list and fetch from Drive.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
# libarchive-tools provides bsdtar, which reads both RAR and ZIP -- the cover
# extractor pulls a few MB from the head of a Drive file and unpacks the first
# page from it, so one code path covers .cbr and .cbz alike.
RUN apk add --no-cache rclone tini libarchive-tools
WORKDIR /app

COPY --from=build /app/.output ./.output
COPY --from=build /app/src/server ./src/server

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
