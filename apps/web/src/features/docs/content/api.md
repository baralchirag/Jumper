# REST API

The endpoints below are the supported public API. Anything not listed here may change without notice.

## Authentication

Send a personal access token:

```sh
curl -H "Authorization: Bearer pcbh_…" https://jumper.example/api/repos/alice/board/issues
```

Browser sessions use a cookie plus `X-Requested-With: jumper` on writes.

## Conventions

* JSON in and out. Errors look like `{"error":"forbidden","message":"…","details":…}` with the matching HTTP status: `400` validation, `401` sign in, `403` not allowed, `404` not found (also for private repos you cannot see), `409` conflict, `422` unparsable design, `429` rate limited.
* Lists take `limit` (max 100) and `offset`.
* Rate limit: 600 requests per minute per user or IP, stricter on sign-in and share links.

## Useful endpoints

| Method & path | Purpose |
|---|---|
| `GET /repos/{o}/{r}/issues?kind=&state=&q=&label=` | list issues or discussions |
| `POST /repos/{o}/{r}/issues` | open one |
| `GET /repos/{o}/{r}/board-stats?path=` | measured board statistics |
| `GET /repos/{o}/{r}/fab-check?path=&profile=` | fab compatibility |
| `GET /repos/{o}/{r}/changelog?base=&head=` | design changes between revisions |
| `GET /repos/{o}/{r}/pinmap?format=header\|zephyr\|csv\|json` | firmware pin map |
| `GET/POST /repos/{o}/{r}/locks` | list / take file locks |
| `GET/POST /repos/{o}/{r}/hooks` | manage webhooks |

All paths are under `/api`.
