# Self-hosting

Jumper is free and open source. You can run it on your own server with Docker.

## What you need

- A Linux server with Docker and Docker Compose. 2 CPU cores and 4 GB of RAM is enough.
- A domain name pointing to the server, if you want HTTPS.

## Install

```sh
git clone https://github.com/baralchirag/gitcad.git jumper
cd jumper
cp .env.example .env
```

Open `.env` and set these:

```sh
POSTGRES_PASSWORD=...        # openssl rand -base64 24
MINIO_ROOT_USER=...
MINIO_ROOT_PASSWORD=...
```

If you have a domain, also set:

```sh
SITE_ADDRESS=jumper.example.com
PUBLIC_URL=https://jumper.example.com
```

Caddy gets the HTTPS certificate for you.

## Start

```sh
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
```

The database is set up when the API starts. Check that it works:

```sh
curl https://jumper.example.com/api/health
```

## Make yourself admin

Sign up in the browser, then run:

```sh
docker compose -f docker/docker-compose.yml exec api node dist/admin.js grant <your-username>
```

Other commands:

| Command                       | What it does |
| ----------------------------- | ------------ |
| `list`                        | List admins |
| `grant <user>`                | Make someone admin |
| `revoke <user>`               | Remove admin |
| `create-user <user> <email>`  | Create an account and print a link to set the password |
| `reset-link <user>`           | Print a password reset link |
| `delete-user <user> --yes`    | Delete an account |

To close sign-ups, set `ALLOW_SIGNUP=false` and create accounts with `create-user`.

## Email

Set an SMTP server to send password resets:

```sh
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=Jumper <noreply@example.com>
```

Without SMTP, reset emails are written to the API log.

## Backups

Your data is in Postgres, the `repos` volume and the MinIO volume.

```sh
scripts/backup.sh
scripts/restore.sh backups/<timestamp>
```

Run `backup.sh` every night with cron and copy the folder to another machine. Keep your `.env` safe too.

## Update

```sh
git pull
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
```

Take a backup first.

## Services

| Service  | What it does |
| -------- | ------------ |
| postgres | Users, repositories, checks |
| redis    | Job queue and live updates |
| minio    | Renders and exports |
| api      | REST API and git over HTTP and SSH |
| worker   | Runs `kicad-cli` in a sandbox |
| web      | Caddy: serves the app and handles HTTPS |

All settings are environment variables. `.env.example` lists them with comments.
