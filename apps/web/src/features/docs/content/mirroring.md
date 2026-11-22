# Mirroring

A mirror keeps a Jumper repository in sync with a copy on GitHub, GitLab, Gitea or any other git host.

Most people keep working on GitHub and let Jumper pull from it.

| Mirror          | What it does                          | When it runs                          |
| --------------- | ------------------------------------- | ------------------------------------- |
| **Pull**        | Fetches branches and tags into Jumper | On a timer, or when you press **Sync now** |
| **Push**        | Sends branches and tags to the remote | After every push to Jumper            |
| **Push + pull** | Both                                  | Both                                  |

## Add a mirror

You can pick a mirror when you import a repository. To add one later, open the repository's **Settings → Mirroring**. Enter the `https://` clone URL and pick a direction.

Private remotes and push mirrors need a token:

- **GitHub:** a fine-grained token for that repository, with *Contents: Read and write*.
- **GitLab:** a project access token with `write_repository` (or `read_repository` for pull only).

The first sync runs right away, so you will see a wrong URL or token at once.

## When both sides change

By default a mirror only fast-forwards. It never overwrites commits and never deletes branches.

If the same branch got new commits on both sides, the mirror shows **Failing** and lists the branches. Merge the two and push. The next sync will work.

Turn on **Overwrite** if one side should always win:

- On a **pull** mirror, the remote wins. Branches deleted there are deleted here too.
- On a **push** mirror, Jumper wins. It force-pushes and deletes remote branches that are gone here.

## Security

Tokens are encrypted on the server and never sent back to the browser. Only repository admins can see or change mirrors. Remotes on private networks are refused.

Only git data is mirrored. Pull requests and issues stay on GitHub.
