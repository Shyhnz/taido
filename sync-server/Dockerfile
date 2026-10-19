# Taido sync server + PWA (docs/SYNC.md § 4.5).
# Build context = repository root:
#   docker build -f sync-server/Dockerfile -t taido-sync-server .

# --- Stage 1: the PWA (mobile/dist) -------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /src
# Same major version as the desktop app (pnpm 11).
RUN npm install --global pnpm@11
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:mobile

# --- Stage 2: the server binary ------------------------------------------------------------
FROM rust:1-bookworm AS server
WORKDIR /src
COPY crates/sync-proto crates/sync-proto
COPY sync-server sync-server
WORKDIR /src/sync-server
RUN cargo build --release --locked

# --- Stage 3: runtime ----------------------------------------------------------------------
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin taido \
    && mkdir -p /data /app \
    && chown taido:taido /data
COPY --from=server /src/sync-server/target/release/taido-sync-server /app/taido-sync-server
COPY --from=web /src/mobile/dist /app/public
ENV TAIDO_SYNC_BIND=0.0.0.0:3020 \
    TAIDO_SYNC_DATA_DIR=/data \
    TAIDO_SYNC_STATIC_DIR=/app/public \
    RUST_LOG=info
USER taido
VOLUME /data
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/app/taido-sync-server", "healthcheck"]
ENTRYPOINT ["/app/taido-sync-server"]
CMD ["serve"]
