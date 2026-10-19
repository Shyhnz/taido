# Self-hosting Taido sync

Taido works fine alone on one computer. If you want your tasks on several computers and on your
phone, you can run your own sync server. Your data stays on your server: nothing goes through
anyone else.

## What you get

- Your tasks, notes and files kept in sync between several computers.
- The Taido web app on your phone, served by your server (add it to the home screen).
- One server can host several accounts (for you, family, a team).

## What you need

- A small server (a VPS) with **Docker** and **Docker Compose** installed.
- A **domain name** (for example `sync.example.com`) with an **A record** pointing to the
  server's IP address.
- Ports **80** and **443** open to the internet. Caddy, included here, uses them to get and
  renew a free HTTPS certificate by itself.

Taido apps only talk to a server over HTTPS (plain HTTP works on `localhost` only), so the
domain is not optional.

## Install

1. Get the code and go to the deploy folder:

   ```sh
   git clone https://github.com/Shyhnz/taido.git
   cd taido/deploy
   ```

2. Put your domain in a settings file:

   ```sh
   cp .env.example .env
   nano .env        # set TAIDO_DOMAIN=sync.example.com (your domain)
   ```

3. Build and start (the first build takes several minutes):

   ```sh
   docker compose up -d --build
   ```

4. Check that it runs. Both containers should be listed, and `taido` should become `healthy`
   after a few seconds:

   ```sh
   docker compose ps
   ```

   Then open `https://sync.example.com` in a browser: you should see the Taido web app login.

## Create your accounts

Accounts are created **from the desktop app**, not from the phone (the phone only signs in).

1. In Taido on your computer, open **Settings › Account**.
2. Enter the server address: `https://sync.example.com`.
3. Create your account (e-mail and a password of at least 10 characters).

Repeat on your other computers by signing in with the same account.

## Close signups

By default, anyone who knows your server address can create an account. Once you have created
the accounts you need, close it:

1. Edit `docker-compose.yml` and change `TAIDO_SIGNUPS: open` to `TAIDO_SIGNUPS: closed`.
2. Apply it:

   ```sh
   docker compose up -d
   ```

Existing accounts keep working (login, sync, password reset). Only new account creation is
refused. To add someone later, set it back to `open`, create the account, and close it again.

## Phone

Open `https://sync.example.com` in your phone's browser, sign in with your account, then use
the browser menu: **Add to home screen**.

## Optional: e-mail

Without e-mail the server works, but there is no "forgot password" and new accounts are
confirmed immediately. To turn e-mail on, uncomment these lines under `environment:` in
`docker-compose.yml` and fill them in with the details from your mail provider, then run
`docker compose up -d`:

| Setting | What it does |
| --- | --- |
| `TAIDO_SMTP_HOST` | Your mail provider's SMTP server. Setting it turns e-mail on. |
| `TAIDO_SMTP_PORT` | Default `465` (implicit TLS). Any other port uses STARTTLS. |
| `TAIDO_SMTP_USER` | SMTP login (give it together with the password). |
| `TAIDO_SMTP_PASSWORD` | SMTP password. |
| `TAIDO_MAIL_FROM` | The sender, for example `Taido <noreply@example.com>`. Required with `TAIDO_SMTP_HOST`. |

`TAIDO_PUBLIC_URL` is already set for you from your domain: it is the address put in the
confirmation e-mail. The server refuses to start if the e-mail settings are incomplete, and the
error tells you what is missing (`docker compose logs taido`).

## Optional: limits

All sizes are whole numbers of bytes. Add them under `environment:` in `docker-compose.yml`
only if you want to change the defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| `TAIDO_MAX_FILE_BYTES` | `104857600` (100 MB) | Largest single file one can attach. |
| `TAIDO_ACCOUNT_QUOTA_BYTES` | `2147483648` (2 GB) | Total file space per account. |
| `TAIDO_MIN_FREE_BYTES` | `2147483648` (2 GB) | Free disk space the server keeps; uploads that would eat into it are refused. |
| `TAIDO_RECORDS_QUOTA_BYTES` | `52428800` (50 MB) | Size of the synchronised tasks and notes per account. |

Files are stored on the server's disk only (in the same volume as the database).

## Backups

Everything lives in one Docker volume, `taido_taido-data`: the database and the `files/`
folder. Back up both together. The simplest safe way is to stop the server for a moment and
copy the volume:

```sh
cd taido/deploy
docker compose stop taido
mkdir -p ~/taido-backups
docker run --rm -v taido_taido-data:/data -v ~/taido-backups:/backup debian:bookworm-slim \
  tar czf /backup/taido-$(date +%F).tar.gz -C /data .
docker compose start taido
```

Keep a copy somewhere other than this server.

**Restoring** a backup: stop the server, replace the volume's content with the archive, then
run `reset-epoch` once so your devices send their latest data again:

```sh
docker compose stop taido
docker run --rm -v taido_taido-data:/data -v ~/taido-backups:/backup debian:bookworm-slim \
  sh -c 'rm -rf /data/* && tar xzf /backup/taido-YYYY-MM-DD.tar.gz -C /data && chown -R 10001:10001 /data'
docker compose run --rm taido reset-epoch
docker compose start taido
```

## Update

```sh
cd taido
git pull
cd deploy
docker compose up -d --build
```

Update the server first, then the apps on your computers. Reload the phone web app afterwards
(the server serves it, so it updates with the server).

## Troubleshooting

- **The app says it cannot reach the server, or refuses the address.** Taido needs
  `https://`. Check that the domain's A record points to the server and that ports 80 and 443
  are open, then look at Caddy: `docker compose logs caddy`.
- **The server does not start or keeps restarting.** Read its log, the message names the
  setting that is wrong: `docker compose logs taido`.
- **Check the server by hand.** This prints nothing and succeeds when the server answers:

  ```sh
  docker compose exec taido /app/taido-sync-server healthcheck && echo OK
  ```

  `docker compose ps` shows the same check as `healthy`.
- **Account creation says signups are closed.** That is `TAIDO_SIGNUPS: closed` working as
  intended; see "Close signups" above.
- **See accounts and devices, or sign out a lost device:**

  ```sh
  docker compose exec taido /app/taido-sync-server accounts
  docker compose exec taido /app/taido-sync-server devices
  docker compose exec taido /app/taido-sync-server revoke <device-id>
  ```

For the protocol and developer details, see `docs/SYNC.md` and `sync-server/README.md`.
