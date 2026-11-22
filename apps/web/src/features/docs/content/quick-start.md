# Quick start

Jumper is a git server for KiCad projects. Every time you push, it runs ERC and DRC, renders the schematic and board, builds the BOM and makes the fab files.

You can push to Jumper directly, or keep your project on GitHub and let Jumper pull from it.

> [!TIP]
> Just want to look around? Pick **Example board** when you create a repository. You get a small board that passes every check.

## Connect a GitHub repository

1. Open **+ → New repository** and choose **Connect from GitHub**.
2. Paste the clone URL, for example `https://github.com/acme/power-supply.git`.
3. If the repository is private, add your GitHub username and a [fine-grained token](https://github.com/settings/personal-access-tokens) with read access.
4. Leave **After importing** on *Keep pulling new commits*.

Jumper copies all branches and tags. After that it pulls new commits on a timer and checks each one. GitLab, Gitea and other git hosts work the same way. See [Mirroring](/docs/mirroring) for more.

## Or push directly

Create an **Empty repository**. Then, from your project folder:

```sh
git init -b main
git add .
git commit -m "Rev A"
git remote add origin https://jumper.example/you/power-supply.git
git push -u origin main
```

Git will ask for a username and password. Use your username and a [personal access token](/settings/tokens) with the `repo:write` scope. You can also use [SSH](/docs/ssh) or the [KiCad plugin](/docs/kicad-plugin).

Commit the `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` files, plus any custom libraries the project uses. Leave out backups and caches:

```gitignore
*.kicad_prl
*-backups/
*.bak
_autosave-*
fp-info-cache
*.lck
```

## Read the checks

Each push runs two jobs. ERC, DRC and BOM usually finish in under a minute. Renders and fab files come after.

| Check   | What it does                                  |
| ------- | --------------------------------------------- |
| ERC     | Runs `kicad-cli sch erc` on each schematic    |
| DRC     | Runs `kicad-cli pcb drc` on each board        |
| BOM     | Groups parts and compares with the last commit |
| Render  | SVG sheets and layers, 3D views               |
| Exports | Gerbers, drill, pick-and-place, PDF, STEP     |

Open the **Checks** tab to see the problems. Click **Locate** to jump to the spot on the board. Download the fab package from **Outputs**.

You can change which checks run in [`.jumper.yml`](/docs/jumper-yml).

## See what changed

Open **Compare** and pick two branches, tags or commits. Jumper shows the parts that were added, removed or changed, the nets that moved, and the two boards side by side or overlaid.

Every commit page also shows the diff against its parent.
