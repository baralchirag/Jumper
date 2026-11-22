# Permissions and security

## Repository roles

| Role      | Can                                                                 |
| --------- | ------------------------------------------------------------------- |
| **Read**  | View files, designs, checks and outputs. Download fab packages.     |
| **Write** | Everything above, plus push, re-run checks and manage mirrors.      |
| **Admin** | Everything above, plus settings, collaborators, webhooks, share links and deleting the repository. |

In an organization, owners are admins and members have write access. On a personal repository, the owner is admin.

People without access to a private repository get "not found".

## Access tokens

Git over HTTPS and the API use personal access tokens. Create them under **Settings → Access tokens**. The scopes are `repo:read`, `repo:write` and `admin`.

A token is shown once and stored as a hash. Give each token only the scope it needs, and set an expiry.

## How Jumper protects your data

- Passwords are hashed with Argon2id. Sign-in is rate limited.
- Session cookies are `HttpOnly`. Browser writes need a custom header, which blocks CSRF.
- Uploaded files are served with a strict Content-Security-Policy.
- Webhooks can't reach private networks.
- Share links store only a hash.
- Sign-ins, token changes, webhook changes and share links are written to the security log.

## Admins

Server admins can open the **Admin** pages. These pages need a signed-in session. Access tokens don't work there.

## Reporting a security problem

Please email the person who runs your server. Don't post security problems in public.
