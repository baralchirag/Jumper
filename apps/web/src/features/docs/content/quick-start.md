# Quick start

Five minutes from a KiCad folder on your disk to a reviewed board. Jumper hosts KiCad projects in git and turns every push into something you can check: rendered schematics and boards, ERC and DRC results, a priced BOM, 3D views and a fab package.

> [!TIP]
> Just looking? Choose **Try the example board** on your dashboard. It creates a private repository with a small board that passes every check, so you can explore before pushing your own.

## 1. Create a repository

Open **+ → New repository**. Name it after the board or product (`power-supply-v2`), choose who can see it, and pick a starting point:

- **Empty**: you push an existing project (most common).
- **Example board**: a complete KiCad project to experiment with.
- **Import from a URL**: copy a repository from GitHub, GitLab or any git host, history included.

Leave *Initialize with README* unticked if you are about to push an existing project, so the first push does not conflict.

## 2. Create an access token

Git over HTTPS asks for a username and password. Use your **username** and a **personal access token** as the password. Create one under [Settings → Personal access tokens](/settings/tokens) with the `repo:write` scope, then copy it straight away: it is shown only once.

```sh
# Optional: remember it after the first push
git config --global credential.helper store
```

## 3. Push your KiCad project

From the folder that contains your `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` files:

```sh
cd ~/kicad/power-supply-v2
git init -b main
git add .
git commit -m "Rev A"
git remote add origin https://jumper.example/you/power-supply-v2.git
git push -u origin main
```

The empty repository page shows these commands with your real URL, and refreshes on its own when the push arrives.

**Already using git?** Add Jumper as a second remote: `git remote add jumper <url>`, then `git push -u jumper --all`.

**What to commit:** the project, schematic and board files, plus any custom symbol, footprint and 3D-model libraries the project uses (keep them under the project folder and reference them with `${KIPRJMOD}`). Leave out backups and caches. The `.gitignore` Jumper suggests does this for you:

```gitignore
*.kicad_prl
*-backups/
*.bak
_autosave-*
fp-info-cache
*.lck
```

## 4. Read the checks

Each push runs the checks below. Results appear on the commit, the repository page and every pull request.

| Check   | What it does                                            | Blocks merges            |
| ------- | ------------------------------------------------------- | ------------------------ |
| ERC     | `kicad-cli sch erc` on every schematic                  | yes (by default)         |
| DRC     | `kicad-cli pcb drc`, with schematic parity              | yes (by default)         |
| BOM     | Groups parts, diffs against the parent commit           | only if you require it   |
| Render  | SVG sheets and layers, ray-traced 3D views              | no                       |
| Exports | Gerbers, drill, pick-and-place, PDFs, STEP, fab package | no                       |

Open the **Checks** tab to see violations grouped by rule. **Locate** jumps to the exact spot on the schematic or board. Download the fab package from **Outputs**.

## 5. Review a change

Make the change in KiCad on a branch, push it, and open a pull request from **Compare**:

```sh
git switch -c bigger-cap
# edit in KiCad, save
git commit -am "C4: 10 µF → 22 µF"
git push -u origin bigger-cap
```

Reviewers see what changed in the *design*, not in the text of the files: parts added, removed or changed, nets rerouted, and the board side by side, overlaid, swiped or in 3D. They can comment on a footprint, pad or track. Merge once the required checks pass and the approvals are in.

## Next

- Choose which checks run and what they block in [`.jumper.yml`](/docs/jumper-yml).
- Invite collaborators or create an organization: [Accounts, organizations & forks](/docs/accounts).
- Something not working? See [Troubleshooting & FAQ](/docs/faq).
