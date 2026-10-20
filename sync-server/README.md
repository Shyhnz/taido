# taido-sync-server

The optional sync server of Taido. It stores, per account, the latest version of every
synchronised row (projects, sections, tasks, shared settings, kanban columns, time
segments…) and the content of attachments, and serves the phone web app (PWA) from the same
origin. Rust (axum + SQLite), one Docker image. The contract is `docs/SYNC.md` (§ 2 and § 4).

The desktop app works without it: sync only starts when you enter a server address and sign
in under Settings › Account. You run your own instance; there is no hosted default.

## Configuration

All configuration is by environment variable.

| Variable | Default | In the Docker image |
| --- | --- | --- |
| `TAIDO_SYNC_BIND` | `127.0.0.1:3020` | `0.0.0.0:3020` |
| `TAIDO_SYNC_DATA_DIR` | `./data` | `/data` (volume) |
| `TAIDO_SYNC_STATIC_DIR` | unset = the web app is not served | `/app/public` |
| `RUST_LOG` | `info` | `info` |
| `TAIDO_SMTP_HOST` | unset = no e-mail | unset |
| `TAIDO_SMTP_PORT` | `465` (implicit TLS; any other port uses STARTTLS) | `465` |
| `TAIDO_SMTP_USER` | none (give it together with the password) | none |
| `TAIDO_SMTP_PASSWORD` | none | none |
| `TAIDO_MAIL_FROM` | required when `TAIDO_SMTP_HOST` is set, e.g. `Taido <noreply@sync.example.com>` | none |
| `TAIDO_PUBLIC_URL` | unset = no address-confirmation e-mail; no domain in mail footers | none |
| `TAIDO_MAX_FILE_BYTES` | `104857600` (100 MB per file) | default |
| `TAIDO_ACCOUNT_QUOTA_BYTES` | `2147483648` (2 GB per account) | default |
| `TAIDO_MIN_FREE_BYTES` | `2147483648` (2 GB kept free on the disk) | default |
| `TAIDO_RECORDS_QUOTA_BYTES` | `52428800` (50 MB of synchronised rows per account) | default |

**Mail.** `TAIDO_SMTP_*` and `TAIDO_MAIL_FROM` send the "forgot password" e-mail (a 6-digit
code) and the address-confirmation e-mail sent at signup. The confirmation e-mail contains a
link to `TAIDO_PUBLIC_URL/confirmer`; without `TAIDO_PUBLIC_URL` (or without mail), new
accounts are confirmed at once. Without `TAIDO_SMTP_HOST` the server still starts, without
e-mail: `POST /api/password/forgot` answers 503 `mail_unavailable`. An incomplete mail
configuration (user without password, missing or malformed sender, invalid port) stops the
server with a clear message. The SMTP password is never written to the logs; the server
certificate is checked against the Mozilla roots built into the binary (rustls, no OpenSSL).

**Limits.** The four `*_BYTES` variables are whole numbers of bytes (no unit); a malformed
value stops the server. An account's quota counts its complete files and the announced size of
its uploads in progress. A new upload that would leave less than `TAIDO_MIN_FREE_BYTES` free on
the disk is refused (507 `quota_exceeded`), as is one that fills the disk. The limits are
logged at startup (`storage limits`).

**Attachment storage.** The content of attachments is always stored on the server's disk, under
`<TAIDO_SYNC_DATA_DIR>/files/`. Cloudflare R2 is no longer supported: the old `TAIDO_R2_*`
variables are ignored (the server logs one warning at startup).

Stored under `<TAIDO_SYNC_DATA_DIR>/files/<account id>/<SHA-256 of account id and attachment
id>` (`.part` while uploading), so no client-supplied name ever reaches a path. The `files`
table records the announced size and hash and whether the file is complete. A file is only
accepted for a live attachment of the account that is already synchronised, and is deleted
when the attachment is. **Back up the `files/` folder together with the database.**

## Local development

```sh
cd sync-server
cargo test                       # unit and integration tests (127.0.0.1 only)
TAIDO_SYNC_DATA_DIR=../sandbox/sync cargo run -- serve
TAIDO_SYNC_DATA_DIR=../sandbox/sync cargo run -- accounts
```

The web app in development goes through the Vite proxy (`/api` → `http://127.0.0.1:3020`).

## Build the image

From the repository root (the build context is the root):

```sh
docker build -f sync-server/Dockerfile -t taido-sync-server .
```

Three stages: Node + pnpm build `mobile/dist` (`pnpm build:mobile`), Rust builds the binary,
then a `debian:bookworm-slim` image with an unprivileged user (uid 10001) runs it.

## Deploy

To run your own server (Docker Compose + Caddy for HTTPS, accounts, backups, updates), follow
`docs/SELF-HOSTING.md`; the ready-to-use files are in `deploy/`.

The server speaks plain HTTP and does not terminate TLS. If you use another setup, run it behind
a reverse proxy (nginx, Caddy, Traefik…) that provides HTTPS, sets `X-Real-IP` to the real
client address, accepts request bodies of at least 16 MiB, and (optionally, the server has its own limiters)
rate-limits `/api/login`, `/api/signup` and `/api/password/`. Check it with `curl -s http://127.0.0.1:3020/api/health`
(`{"ok":true,"protocol":3}`) or `taido-sync-server healthcheck`. Account creation can be closed
with `TAIDO_SIGNUPS=closed` (`docs/SYNC.md` § 0.2). E-mails and the confirmation page are in
English, or in French with `TAIDO_MAIL_LANG=fr`.

## Daily backup

The database is `<data>/sync.sqlite3` (WAL mode). `sqlite3 .backup` makes a consistent copy
while the server runs. Example `crontab` line (every day at 3:15, keeps 30 days):

```cron
15 3 * * * sqlite3 /srv/taido-sync/data/sync.sqlite3 ".backup '/srv/taido-sync/backups/sync-$(date +\%F).sqlite3'" && find /srv/taido-sync/backups -name 'sync-*.sqlite3' -mtime +30 -delete
```

(In a crontab, `%` must be written `\%`.) Back up `data/files/` too.

## Restore a backup

```sh
cd /srv/taido-sync
docker compose stop
cp backups/sync-YYYY-MM-DD.sqlite3 data/sync.sqlite3
rm -f data/sync.sqlite3-wal data/sync.sqlite3-shm     # journals of the old database
chown 10001:10001 data/sync.sqlite3
docker compose run --rm taido-sync reset-epoch
docker compose start
```

`reset-epoch` is required: devices see that the database changed identity, reset their cursor
and send their rows again, so the union of all data is rebuilt and the newest versions win
(`docs/SYNC.md` § 2.6). Devices stay signed in (tokens are in the backup); a device linked
after the backup date must sign in again.

## Protocol version

The server speaks protocol 3 (`/api/health` reports it). A desktop or phone app on an older
protocol gets `unsupported_protocol` and stops syncing: deploy the new image together with
the new app version, then reload the phone web app (this server serves it). The server
starts on a new, empty data directory; a database from the earlier single-account version
that holds data is refused.

## Devices

```sh
docker compose exec taido-sync /app/taido-sync-server accounts
docker compose exec taido-sync /app/taido-sync-server devices [<email>]
docker compose exec taido-sync /app/taido-sync-server revoke <id>
```
