# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context, then scans the
# finished image with no network. Everything the build, the tests and a reproducer
# need is fetched here. What the scanner should look at is in threat_model.md.

# Same Node as CI and the published image.
FROM node:22.17.1-bookworm

# git: the vault is a git repository and the server commits every write.
# python3-pytest: the Hermes integration's test suite (the plugin itself is stdlib-only).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 python3-pytest \
  && rm -rf /var/lib/apt/lists/*

# Same pnpm as CI and package.json "packageManager".
RUN npm install --global pnpm@9.15.0

# Production recall embeds with EmbeddingGemma, a 333 MB model downloaded on first
# use. There is no network at scan time, so a server started in this image uses the
# deterministic hash embedder instead, as the test suite does.
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1 \
    LIBRARIAN_EMBEDDER=hash

# The scanner's contract: the checkout lives at /src.
COPY . /src
WORKDIR /src

# The repository's .dockerignore leaves .git out of the build context, but the root
# `prepare` script (lefthook install) needs a git repository. A fresh one with the
# checkout committed also gives a clean baseline to diff a proposed patch against.
RUN git init -q \
  && git add -A \
  && git -c user.name=oss-scanner -c user.email=oss-scanner@localhost commit -qm "checkout"

RUN pnpm install --frozen-lockfile \
  && pnpm build

# Chromium for the dashboard's Playwright suite (pnpm --filter @librarian/dashboard test:e2e).
RUN pnpm --filter @librarian/dashboard test:e2e:install

# Run the unit suites so we know the image works, without letting a failure abort the
# build. This is `pnpm test` without its rebuild (done above), and with --no-bail so
# one failing package doesn't skip the rest.
RUN pnpm -r --no-bail run test:vitest \
    || echo "WARNING: the workspace vitest suites reported failures"
RUN pnpm exec vitest run \
    || echo "WARNING: the root vitest suite reported failures"
RUN (cd integrations/hermes && python3 -m pytest -q) \
    || echo "WARNING: the Hermes pytest suite reported failures"
