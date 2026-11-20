# Mirroring with GitHub and GitLab

A mirror keeps a Jumper repository in step with a copy on GitHub, GitLab, Gitea or any host that serves git over HTTPS. This is the usual way to use Jumper: keep working on GitHub, and let Jumper check, price and compare every commit.

| Mirror | What it does | When it runs |
| --- | --- | --- |
| **Push** | Sends branches and tags from Jumper to the remote. | After every push here. A failed attempt is retried on its interval. |
| **Pull** | Fetches branches and tags from the remote into Jumper. | On its interval (10 minutes to once a day), or when you press **Sync now**. |
| **Push + pull** | A two-way mirror: work can happen on either side. | Both of the above. |

## Import and keep in sync

On **+ → New repository → Connect from GitHub**, choose what happens after the import:

- **Keep a one-time copy**: no mirror. The access token is used once and never stored.
- **Keep pulling new commits** (the default): a pull mirror. Every new commit on GitHub is analyzed as soon as it is fetched.
- **Two-way**: a pull mirror and a push mirror to the same repository. This needs a token that can write to it.

## Add a mirror later

Open the repository's **Settings → Mirroring**, enter the remote's `https://` clone URL, and choose a direction. For private remotes and for push mirrors, add an access token:

- **GitHub:** a fine-grained personal access token limited to that repository, with *Contents: Read and write*.
- **GitLab:** a project access token with the `write_repository` scope (`read_repository` for pull-only).

The first sync runs immediately, so a wrong URL or token shows up right away. Pasting `https://user:token@host/…` works too: the credentials are taken out of the URL and stored separately.

## When both sides change

By default mirrors only **fast-forward** and never delete branches. If the same branch got new commits on both sides, nothing is overwritten. The mirror shows **Failing** and names the branches. To fix it, merge the remote's changes into the Jumper branch (or the other way round) and push. The next sync then succeeds.

Turn on **Overwrite** to make one side the source of truth:

- On a **pull** mirror, the remote always wins. Branches deleted there are deleted here, so the Jumper copy becomes a read-only replica.
- On a **push** mirror, Jumper always wins: it force-pushes, and deletes branches on the remote that no longer exist here.

## Security

Access tokens are encrypted (AES-256-GCM) with the server's key and never sent back to the browser. Only repository admins can see or change mirrors. Every add, change and removal is in the security log. Remotes on private or internal networks are refused.

> [!TIP]
> Only git data is mirrored: branches, tags and their history. Pull requests and issues stay on GitHub, where your team already works.
