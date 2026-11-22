# Troubleshooting

## Pushing and cloning

**Git keeps asking for my password.** Use your username and a personal access token, not your password. Pushing needs the `repo:write` scope. If you changed tokens, clear the old one from your git credential helper.

**`'main' is protected and cannot be force-pushed`.** Protected branches don't allow rewritten history. Revert the commit instead of resetting it.

**`rejected (fetch first)` or `non-fast-forward`.** Someone pushed before you. Run `git pull --rebase` and push again.

**`Push exceeds the maximum allowed size`.** One push can be up to 500 MB by default. Push in smaller parts, and don't commit Gerbers, renders or backups.

**Should I commit Gerbers?** No. Jumper makes them for every commit. You'll find them under **Outputs**.

## Checks

**"No KiCad project found in this commit".** Jumper looks for `*.kicad_pro` files anywhere in the repository. Check that they are committed with `git ls-files '*.kicad_*'`. If your project is in an odd place, list it under `projects:` in [`.jumper.yml`](/docs/jumper-yml).

**Checks never start.** Checks normally start within a minute. If nothing happens after a few minutes, push again or tell your admin.

**A check says `timed_out`.** One step gets 5 minutes and a whole commit gets 10. Big boards with high-quality renders are the usual cause. Set `render_quality: basic` or turn off outputs you don't need.

**DRC fails with "unconnected items" while I'm still routing.** Set `checks.drc.fail_on_unconnected: false` until routing is done.

**ERC or DRC fails on a rule that's fine for this board.** Change that one rule under `severity_overrides`, for example `silk_overlap: ignore`.

**Parts are missing in the 3D view.** The footprint points to a 3D model Jumper can't find. Models from KiCad's own library are found automatically. Custom models must be committed and referenced with `${KIPRJMOD}/…`. The Render check lists every missing model.

### Missing libraries

ERC and DRC list libraries that a fresh clone can't find.

| Message | Fix |
| --- | --- |
| *Not a standard KiCad library and not in the project's sym-lib-table* | Copy the library into the repository, add it under **Preferences → Manage Symbol Libraries → Project Specific Libraries** with `${KIPRJMOD}/…`, and commit `sym-lib-table`. |
| *Listed in the project's sym-lib-table, but that file is not committed* | Check `.gitignore` and `git add` the file. |
| *… is used as a sheet but is not committed* | Commit the missing sheet file. |

Footprint libraries work the same way. They are folders ending in `.pretty`, listed in `fp-lib-table`.

You never need to commit standard KiCad libraries like `Device` or `Resistor_SMD`.

**The Fab check can't read the board.** KiCad 5 and older files are not supported. Open and save the board in KiCad 7 or newer.

## Mirrors

**My GitHub repository stopped updating.** Open **Settings → Mirroring** to see the last error. Most of the time the GitHub token has expired. Paste a new one and press **Sync now**.

**Two people changed the same board.** KiCad files can't be merged line by line safely. Use **Compare** to see both changes, then redo the smaller one in KiCad on top of the other.

## Accounts

**I lost a share link.** Links can't be recovered. Revoke it and make a new one.

**A webhook says "Destination resolves to a non-public address".** Webhooks can't call private networks. Use a public `https://` address.

**I can't delete my account.** The dialog tells you why. Usually you are the only owner of an organization or the only admin.
