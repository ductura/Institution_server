# The web process of the server (DAN-893): `docker build -f infra/web/Dockerfile .`
# from the repository root. Two stages: `build` installs every dependency and
# bundles server/server.ts into dist/server.js (scripts/build); the final stage
# gets that one file and nothing of node_modules. Configuration comes only from
# the environment at `docker run` (APP_DATABASE_URL and the rest, see
# server/config); the image holds no value of it and no secret, and no NODE_ENV
# (unset counts as production). Base from mirror.gcr.io as compose.yaml (Docker
# Hub limits); change it only by its digest, in both stages, with .nvmrc
# (infra/web/dockerfile.test.ts).
FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/test-fakes/package.json packages/test-fakes/
# --ignore-scripts: `prepare` installs git hooks, which a build has no use for.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
WORKDIR /app
COPY --from=build /src/dist/server.js dist/server.js
# Listen on every interface: the default HOST is the loopback
# (server/config/environment.ts), unreachable from outside a container.
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000
USER node
# The liveness route of the contract platform.health.get: 200 also when degraded,
# so healthy means the process answers, not that a database is ready. The
# timeout is above the route's own 2.5 s deadline (server/http/health.ts).
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disallow-code-generation-from-strings", "dist/server.js"]
