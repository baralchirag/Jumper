# Quick start

Jumper works next to GitHub. Your KiCad project stays where it is; Jumper follows it and turns every commit into something you can check: rendered schematics and boards, ERC and DRC results, a priced BOM, a visual diff against any other revision, and a fab package.

> [!TIP]
> Just looking? Choose **Example board** when you create a repository. You get a small board that passes every check, so you can explore before connecting your own.

## 1. Connect your repository

Open **+ → New repository** and choose **Connect from GitHub**:

1. Paste the address you would use with `git clone`, for example `https://github.com/acme/power-supply.git`.
2. For a private repository, open **This repository is private** and add a GitHub username and a [fine-grained token](https://github.com/settings/personal-access-tokens) with read access to that one repository. It is stored encrypted.
3. Leave **After importing** on *Keep pulling new commits from the original*.

Jumper copies every branch and tag, then pulls new commits on a schedule. Each new commit is analyzed the moment it arrives. GitLab, Gitea and any other host that serves git over HTTPS work the same way. More in [Mirroring with GitHub & GitLab](/docs/mirroring).

**Prefer to push to Jumper directly?** Choose **Empty repository** instead, then follow [Pushing directly](#pushing-directly) below.

## 2. Read the checks

Each new commit gets two passes. The quick one (ERC, DRC, BOM) usually reports within a minute; renders and manufacturing files follow.

| Check   | What it does                                            |
| ------- | ------------------------------------------------------- |
| ERC     | `kicad-cli sch erc` on every schematic                  |
| DRC     | `kicad-cli pcb drc`, with schematic parity              |
| BOM     | Groups parts, prices them, diffs against the parent commit |
| Render  | SVG sheets and layers, 3D views                         |
| Exports | Gerbers, drill, pick-and-place, PDFs, STEP, fab package |

Open the **Checks** tab to see violations grouped by rule. **Locate** jumps to the exact spot on the schematic or board. Download the fab package from **Outputs**. Choose which checks run, and how strict they are, in [`.jumper.yml`](/docs/jumper-yml).

## 3. See what changed

Open **Compare**, pick two branches, tags or commits, and Jumper shows what changed in the *design*, not in the text of the files: parts added, removed or changed, nets rerouted, and the board side by side, overlaid, swiped or in 3D. Every commit page shows the same diff against its parent.

Reviewing a GitHub pull request? Compare its branch with `main` on Jumper and paste the link into the pull request.

## Pushing directly

Git over HTTPS asks for a username and password. Use your **username** and a **personal access token** as the password. Create one under [Settings → Personal access tokens](/settings/tokens) with the `repo:write` scope; it is shown only once. SSH keys work too ([Git over SSH](/docs/ssh)), and so does the [KiCad plugin](/docs/kicad-plugin).

From the folder that contains your `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` files:

```sh
cd ~/kicad/power-supply
git init -b main
git add .
git commit -m "Rev A"
git remote add origin https://jumper.example/you/power-supply.git
git push -u origin main
```

**Already on GitHub?** Add Jumper as a second remote: `git remote add jumper <url>`, then `git push -u jumper --all`.

**What to commit:** the project, schematic and board files, plus any custom symbol, footprint and 3D-model libraries the project uses (keep them under the project folder and reference them with `${KIPRJMOD}`). Leave out backups and caches:

```gitignore
*.kicad_prl
*-backups/
*.bak
_autosave-*
fp-info-cache
*.lck
```

## Next

- Tune checks and outputs in [`.jumper.yml`](/docs/jumper-yml).
- Add your team: [Accounts & organizations](/docs/accounts).
- Something not working? See [Troubleshooting & FAQ](/docs/faq).
