# REST API

All paths start with `/api`. The endpoints on this page are stable. Others may change.

## Authentication

Create a personal access token under **Settings → Access tokens** and send it in the `Authorization` header:

```sh
curl -H "Authorization: Bearer pcbh_…" https://jumper.example/api/repos/alice/board/checks
```

## Basics

- Requests and responses are JSON.
- Errors look like `{"error":"forbidden","message":"…"}`.
- Private repositories you can't see return `404`, not `403`.
- Lists take `limit` (max 100) and `offset`.
- The rate limit is 600 requests per minute.

## Endpoints

| Method and path                                      | What it returns                        |
| ---------------------------------------------------- | -------------------------------------- |
| `GET /repos/{o}/{r}/checks?sha=`                     | Check results for a commit             |
| `POST /repos/{o}/{r}/checks/rerun`                   | Runs the checks again                  |
| `GET /repos/{o}/{r}/artifacts?sha=`                  | Renders, Gerbers, fab package, STEP    |
| `GET /repos/{o}/{r}/compare?base=&head=`             | Commits and files between two revisions |
| `GET /repos/{o}/{r}/semantic-diff?base=&head=&path=` | Parts, nets and tracks that changed    |
| `GET /repos/{o}/{r}/bom?ref=&path=`                  | The BOM                                |
| `GET /repos/{o}/{r}/bom/pricing?ref=&path=&quantity=` | Stock and prices from suppliers       |
| `GET /repos/{o}/{r}/board-stats?path=`               | Board statistics                       |
| `GET /repos/{o}/{r}/fab-check?path=&profile=`        | Fab compatibility                      |
| `GET /repos/{o}/{r}/changelog?base=&head=`           | Design changes                         |
| `GET /repos/{o}/{r}/pinmap?format=header\|zephyr\|csv\|json` | Firmware pin map               |
| `GET/POST /repos/{o}/{r}/mirrors`                    | List or add mirrors                    |
| `GET/POST /repos/{o}/{r}/hooks`                      | List or add webhooks                   |
