# KiCad plugin

The Jumper plugin adds a button to KiCad's PCB editor that commits, pushes and pulls the open project. You see what changed, write a message, and send it to Jumper without opening a terminal.

## Install

1. [Download the plugin](/api/downloads/kicad-plugin.zip). It is served by this Jumper server, so it always matches its version.
2. In KiCad, open **Plugin and Content Manager → Install from File…** and choose the zip.
3. Close and reopen the **PCB Editor**.

The plugin needs [git](https://git-scm.com) on your PATH. It works with KiCad 7, 8 and 9 on Windows, macOS and Linux.

## Where to find it

Jumper lives in the **PCB Editor**, not in the KiCad project window. Open your board, then either:

- click the **Jumper** button at the right end of the top toolbar, or
- choose **Tools → External Plugins → Jumper**.

Not there?

1. In the PCB Editor choose **Tools → External Plugins → Refresh Plugins**.
2. Still missing from the toolbar: open **Preferences → PCB Editor → Action Plugins** and tick **Show button** next to Jumper.
3. Check **Plugin and Content Manager → Installed**: Jumper should be listed. If KiCad reports a plugin error, download the plugin again from this page and reinstall.

## Connect a project

Open the board and press the Jumper button. If the project folder is not connected yet:

1. Create an **empty** repository on Jumper (**+ → New repository**).
2. Paste its clone URL into the plugin.
3. For an `https://` URL, also paste a [personal access token](/settings/tokens) with the `repo:write` scope. SSH URLs use your [SSH key](/settings/ssh-keys) instead.

The plugin creates the git repository if needed, adds a `.gitignore` for KiCad's backups, lock files and local settings (`*.kicad_prl`), commits everything and pushes. If the repository on Jumper already has commits, your files are committed on top of them.

## Everyday use

| Button | What it does |
| --- | --- |
| **Commit and push** | Saves every changed file in one commit with your message, then pushes the current branch. |
| **Pull** | Fetches new commits from Jumper and fast-forwards your copy. Reopen the board afterwards (**File → Revert**) to load them. |
| **New branch…** | Starts a branch for a change you want reviewed. Your uncommitted work comes along. |
| **Open pull request** | Opens Jumper with this branch ready to compare against `main`, so your team reviews the board change as a board. |
| **View checks** | Opens the ERC, DRC, render and BOM results for your latest push. The dialog also shows them live: running, passed or which checks failed. |
| **Open on Jumper** | Opens the repository in your browser, with the renders and check results for your latest push. |
| **Token…** | Changes or removes the saved access token for this server. |

The dialog shows how many commits are waiting on Jumper and how many of yours are not pushed yet.

> [!NOTE]
> Save the board before pulling. The plugin refuses to pull while the PCB editor has unsaved changes, so a pull can never overwrite your work.

## When both sides changed

The plugin never merges or rewrites history on its own. If a teammate pushed while you were working, **Push** says someone else pushed first and **Pull** says both copies have new commits. Two ways forward:

- **Push to a branch:** in a terminal, `git push origin HEAD:my-change`, then open a pull request on Jumper and review the visual diff there.
- **Rebase:** in a terminal in the project folder, `git pull --rebase`. Then reopen the board in KiCad, check it, and push.

Branch protection works as usual: if `main` requires pull requests, push to a branch.

## Where the token is stored

Tokens are saved per server in `~/.config/jumper/kicad-plugin.json` (`%APPDATA%\jumper\` on Windows). The file is readable only by your user. A token is only ever sent to the server it was saved for, and only over HTTPS.
