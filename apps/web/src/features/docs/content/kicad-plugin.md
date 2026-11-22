# KiCad plugin

The plugin adds a Jumper button to KiCad's PCB editor. It lets you commit, push and pull without opening a terminal.

## Install

1. [Download the plugin](/api/downloads/kicad-plugin.zip).
2. In KiCad, open **Plugin and Content Manager → Install from File** and pick the zip.
3. Close and reopen the PCB editor.

You need [git](https://git-scm.com) installed. The plugin works with KiCad 7, 8 and 9 on Windows, macOS and Linux.

## Find the button

The button is in the **PCB editor**, not the project window. Open your board, then either:

- click **Jumper** on the right of the top toolbar, or
- go to **Tools → External Plugins → Jumper**.

If you can't see it:

1. Go to **Tools → External Plugins → Refresh Plugins**.
2. Open **Preferences → PCB Editor → Action Plugins** and tick **Show button** next to Jumper.
3. Check that Jumper is listed under **Plugin and Content Manager → Installed**.

## Connect a project

Open the board and press the button. If the folder is not connected yet:

1. Create an empty repository on Jumper.
2. Paste its clone URL into the plugin.
3. For an `https://` URL, paste a [personal access token](/settings/tokens) with `repo:write`. SSH URLs use your [SSH key](/settings/ssh-keys).

The plugin sets up git, adds a `.gitignore` for KiCad's backup files, commits everything and pushes.

## Buttons

| Button                | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| **Commit and push**   | Commits all changed files with your message and pushes.   |
| **Pull**              | Gets new commits. Use **File → Revert** to reload the board. |
| **New branch**        | Starts a new branch. Your uncommitted work comes with you. |
| **Compare on Jumper** | Opens this branch compared with `main`.                   |
| **View checks**       | Opens the check results for your last push.               |
| **Open on Jumper**    | Opens the repository in your browser.                     |
| **Token**             | Changes or removes the saved token.                       |

> [!NOTE]
> Save the board before you pull. The plugin won't pull while there are unsaved changes.

## When someone else pushed first

The plugin never merges for you. If a teammate pushed while you were working, you have two options:

- Push to a new branch: `git push origin HEAD:my-change`. Then use **Compare** on Jumper.
- Rebase: run `git pull --rebase` in the project folder, reopen the board, check it, and push.

## Where the token is saved

`~/.config/jumper/kicad-plugin.json` on Linux and macOS, `%APPDATA%\jumper\` on Windows. Only your user can read the file. A token is only sent to the server it was saved for.
