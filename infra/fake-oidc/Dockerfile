# The fake OIDC provider of the staging (STG-OIDC, Ductus#2055; owner decision
# of 23. 11. 2026., "Idemo B"): `docker build -f infra/fake-oidc/Dockerfile .`
# from the repository root. Its own Render service, ductura-fake-oidc-staging
# (render.staging.yaml, docs/STAGING.md), never a route of the server (U9).
# The image holds no secret and no .env file (Dockerfile.dockerignore): the
# client secret, the cookie key, APP_ORIGIN and ISSUER come only from the
# environment at run time, and the provider refuses to start without them
# (packages/test-fakes/oidc/staging.ts). DUCTURA_DEPLOYMENT=staging is fixed
# here, so this image never runs the local mode; NODE_ENV stays unset, which
# the provider's guard allows. Base as infra/web/Dockerfile (same digest,
# .nvmrc); Node runs the TypeScript sources directly (type stripping).
FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/test-fakes/package.json packages/test-fakes/
# Only the production dependencies of @ductura/test-fakes, from the lockfile.
# --ignore-scripts: `prepare` installs git hooks, which a build has no use for.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @ductura/test-fakes

FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/test-fakes/node_modules packages/test-fakes/node_modules
COPY packages/test-fakes/package.json packages/test-fakes/package.json
# The provider's sources; tests stay out (Dockerfile.dockerignore).
COPY packages/test-fakes/oidc packages/test-fakes/oidc
ENV DUCTURA_DEPLOYMENT=staging PORT=8090
EXPOSE 8090
USER node
# The provider answers its discovery document while it runs.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/.well-known/openid-configuration').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "packages/test-fakes/oidc/server.ts"]
