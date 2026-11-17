# Troubleshooting & FAQ

## Pushing and cloning

**Git keeps asking for my password, or says "Authentication failed".** Use your **username** and a **personal access token**, not your account password. The token needs the `repo:write` scope to push (`repo:read` is enough to clone a private repository). If you changed tokens, clear the old one from your credential helper. On macOS: `git credential-osxkeychain erase`. On Windows: Credential Manager → *Windows Credentials*.

**`error: 'main' is protected: open a pull request instead of pushing directly.`** The branch has protection rules. Push to a new branch (`git push -u origin my-change`) and open a pull request. Repository admins can change the rules under **Settings → Branch protection**.

**`error: 'main' is protected and cannot be force-pushed.`** Protected branches reject rewritten history. Revert the commit instead of resetting, or ask an admin to relax the rule.

**`rejected … (fetch first)` or `non-fast-forward`.** Someone pushed before you, or the repository was created with a README. Run `git pull --rebase` and push again. For a brand-new repository you can also start over with an empty one.

**`Push exceeds the maximum allowed size`.** One push is limited to 500 MB by default (the operator can change this). Push in several commits, and keep generated files such as Gerbers, renders and backups out of git: Jumper generates them for you.

**Should I commit Gerbers and other fab outputs?** No. They are produced for every commit and available under **Outputs** and as the fab package. Committing them makes diffs noisy and repositories large.

## Checks

**My project is not detected ("No KiCad project found in this commit").** Jumper looks for `*.kicad_pro` files anywhere in the repository, plus boards committed without one. Check that the files were committed (`git ls-files '*.kicad_*'`) and not excluded by `.gitignore`. If the project is in an unusual place, list it under `projects:` in [`.jumper.yml`](/docs/jumper-yml).

**My checks never start.** Open the commit's **Checks** page: checks usually start within a minute of a push. If nothing has started after a few minutes, push again or contact support with the repository and commit.

**A check says `timed_out`.** A single step gets 5 minutes and a whole commit 10 minutes by default. Very large boards with `render_quality: high` are the usual cause: set `render_quality: basic`, or turn off outputs you do not need.

**DRC fails with "unconnected items" on a board I'm still routing.** Set `checks.drc.fail_on_unconnected: false` until routing is finished, or `fail_on: never` to see violations without failing.

**ERC or DRC fails on something that is fine for this board.** Re-grade that rule under `severity_overrides` (for example `silk_overlap: ignore`) instead of turning the whole check off.

**The 3D view has missing parts, or boxes instead of components.** The footprint points at a 3D model Jumper cannot find. Models from KiCad's standard library are found automatically, including old paths such as `${KICAD6_3DMODEL_DIR}` and `.wrl` names. Custom models must be committed to the repository and referenced with `${KIPRJMOD}/…`. The Render check lists every model it could not resolve.

**Symbols or footprints look wrong in the render.** Schematics and boards embed the symbols and footprints they use, so renders normally match KiCad exactly. If a project depends on project-specific libraries, commit the library files and the `sym-lib-table` / `fp-lib-table` next to the project.

### Missing libraries

The ERC and DRC results list every symbol and footprint library the project uses that a fresh clone cannot find, plus sheet files and 3D models that were not committed. Jumper still renders the design from the copies KiCad keeps inside it, but a teammate who clones it gets a warning per symbol and cannot update parts from those libraries.

| What the check says | What to do |
| --- | --- |
| *Not a standard KiCad library and not in the project's sym-lib-table* | The library lives only on the author's computer. Copy it into the repository (for example `libs/MyParts.kicad_sym`), then in KiCad open **Preferences → Manage Symbol Libraries → Project Specific Libraries**, add it with the path `${KIPRJMOD}/libs/MyParts.kicad_sym`, and commit `sym-lib-table` too. |
| *Listed in the project's sym-lib-table, but that file is not committed* | The table is there but the library file is not. Check `.gitignore`, then `git add` the file. |
| The same for footprints | Footprint libraries are folders ending in `.pretty`. Commit the folder and list it under **Project Specific Libraries** in **Manage Footprint Libraries** (`fp-lib-table`). |
| *… is used as a sheet but is not committed* | A hierarchical sheet file is missing. Its pages are missing from renders and the BOM until you commit it. |

Standard KiCad libraries (`Device`, `Resistor_SMD`, …) never need committing.

**The Fab check tab says it cannot analyse the board.** The file must be a valid `.kicad_pcb`. Very old formats (KiCad 5 and earlier) are not supported: open and re-save the board in KiCad 7 or newer.

**The Firmware tab says there is no netlist.** Make sure `netlist` under `outputs` in `.jumper.yml` is not set to `false`, then wait for the checks on that commit to finish.

## Pull requests and review

**I cannot merge: `Required check "DRC" failed` (or "is still running", "has not run").** Every check in `required_checks` must succeed on the pull request's latest commit. Fix the violations and push again; the pull request updates on its own. "Has not run" usually means the check is disabled in `.jumper.yml` but still required.

**I cannot merge: "locked by another user".** A colleague holds a whole-file lock on a file this pull request changes. Ask them to release it, or ask a repository admin to.

**I cannot merge: a sign-off rule.** The blocker names the rule. Ask one of the listed approvers to approve, or ask an admin to adjust the rule under **Settings → Review process**.

**Two people edited the same board and the merge conflicts.** KiCad files are text but are not safe to merge line by line. Lock the `.kicad_pcb` while you work on it (open the file in Jumper and use the **Lock** panel), or have one person rebase and redo the smaller change in KiCad.

## Accounts and access

**I forgot my password.** Use *Forgot your password?* on the sign-in page. If your instance has no email, ask an administrator for a reset link.

**I lost a share link.** Links cannot be recovered, because only a hash is stored. Revoke the old one and create a new one.

**A webhook shows "Destination resolves to a non-public address".** Jumper refuses to call private networks. Expose your endpoint on a public https address.

**I can't delete my account.** The dialog says why: you are the only owner of an organization, or the only administrator. Fix that first, then try again.

## Still stuck?

Open an issue on the repository with the failing check's log (**Checks → Details**), or contact the operator of your instance. Their address is on the [terms](/terms) page.
