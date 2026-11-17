# Permissions & security

## Roles on a repository

| Role | Can |
|---|---|
| **Read** | view code, designs, checks; open issues and discussions; comment |
| **Write** | everything above, plus push, open and review pull requests, triage issues, lock files |
| **Admin** | everything above, plus change settings, manage collaborators, webhooks, share links and rules, delete the repository |

Repositories owned by an organization give **owners** admin and **members** write access. On a personal repository the owner is admin.

Private repositories are invisible to people without access: they get "not found", not "forbidden".

## Access tokens

Git over HTTPS and the API accept a **personal access token** (Settings → Access tokens). Scopes: `repo:read`, `repo:write`, `admin`. Tokens are shown once and stored hashed; give each one the least scope it needs and an expiry.

## What Jumper does to protect you

* Passwords are hashed with Argon2id; sign-in is rate limited and timing-hardened against account enumeration.
* Sessions use `HttpOnly` cookies; browser writes require a custom header (CSRF protection).
* Uploaded and rendered files are served with `nosniff` and a sandboxing Content-Security-Policy.
* Webhook destinations are checked against private networks, and responses are never followed or stored.
* Share links store only a hash of their token and return the same "not found" for invalid, expired and revoked links.
* Every sensitive action — token and webhook changes, share links, locks, rules, sign-ins — is written to the audit log.

## Administrators

Site administrators are people on the Jumper team. Admin pages need a signed-in admin session; access tokens are refused there.

## Reporting a vulnerability

Email the instance operator, or the address in the project's `SECURITY.md`. Please do not open a public issue for security problems.
