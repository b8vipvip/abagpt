# Multi-platform index digest for the official Node 24 Bookworm slim image.
# Pin the index (not an amd64-only manifest) so both release architectures resolve identically.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build
# devDependencies stay in the image below rather than being pruned or
# reinstalled fresh - both npm prune --omit=dev (bulk-delete) and a second
# `npm ci --omit=dev` (bulk-write) hang for a very long time on this
# machine's Colima setup, apparently regardless of which direction the
# many-small-files I/O goes. Simplest reliable fix: just keep the one
# node_modules the build stage already produced, dev packages and all.
# Bigger runtime image, but it actually finishes building.

FROM ${NODE_IMAGE} AS runtime

ARG MIRROR_VERSION=development
ARG MIRROR_BUILD_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/b8vipvip/abagpt" \
      org.opencontainers.image.version=$MIRROR_VERSION \
      org.opencontainers.image.revision=$MIRROR_BUILD_REVISION
ENV MIRROR_VERSION=$MIRROR_VERSION \
    MIRROR_BUILD_REVISION=$MIRROR_BUILD_REVISION

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    MIRROR_DATA_DIR=/home/node/.mirror \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY scripts/storage.mjs scripts/restore-drill.mjs ./scripts/
RUN mkdir -p /home/node/.mirror && chown node:node /home/node/.mirror
USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
