# Pull requests & review

A pull request proposes merging one branch into another. Jumper shows what changed in the *design*, not just in the text of the files.

## Opening one

Choose **New pull request** on the Pull requests tab, pick the base and compare branches and describe the change. The **Design changes** panel on the conversation tab lists, in plain language, which parts were added, removed or changed, which values were edited and which nets were rerouted. Use **Copy as Markdown** to paste it into your release notes.

## Reviewing

* **Files changed** shows text diffs for source files and a semantic, visual diff for schematics and boards (side by side, overlay or swipe).
* Click an object in a design diff to comment on that exact part, track or net. Comments on lines work as usual.
* **Review** → *Approve*, *Request changes* or *Comment*. You cannot approve your own pull request.
* Mention people with `@username` to notify them. People who cannot read the repository are never notified.

## What blocks a merge

The merge box lists every blocker. A pull request is mergeable only when all of these hold:

1. No conflicting files (design conflicts are resolved object by object).
2. Required checks from [`.jumper.yml`](/docs/jumper-yml) have passed.
3. The repository's **required approvals** are met and nobody has requested changes.
4. Every [sign-off rule](#sign-off-rules) that matches a changed file is satisfied.
5. If enabled, the review checklist is complete.
6. No other person holds a whole-file [lock](#locks) on a changed file.

## Review checklist

Settings → **Review process** lets you define a template, one item per line. It is copied onto each pull request the first time it is viewed. Collaborators tick items off; anyone can see who ticked what. Turn on **Require the checklist before merging** to enforce it.

## Sign-off rules

A rule pairs a file pattern with the people who must approve changes to it, for example:

| Name | Pattern | Approvers |
|---|---|---|
| Power sign-off | `power/**` | `alice` |
| RF sign-off | `*.kicad_pcb` | `bob, carol` (2 required) |

Patterns use `*` (within a folder), `**` (across folders) and `?`. A pattern without a `/` matches the file name in any folder. If you leave the approver list empty, any collaborator's approval counts.

## Locks

When you start editing a file that cannot be merged automatically — a board layout, say — lock it from the file's page so a colleague does not route the same area. Choose how long the lock lasts (30 minutes to a week); it expires on its own.

* A **whole-file lock** also blocks merging someone else's changes to that file.
* **Region locks** (an area of the board, set through the API) are advisory: they warn others but do not block merges, because a file-level diff cannot say which region changed.
* Only the lock's owner or a repository admin can release it early.

## Branch protection

Settings → **Branch protection** guards important branches such as `main` or `release/*`:

| Option | Effect |
|---|---|
| Require a pull request | direct pushes are refused; changes arrive only by merging a pull request |
| Block force-pushes | history cannot be rewritten |
| Block deletion | the branch cannot be deleted from git or the website |
| Apply to administrators | off by default, so an admin can bypass in an emergency |

Rules are enforced by a `pre-receive` hook inside git, so they hold for every client — command line, IDE or API — and the refusal message appears in the terminal (`remote: error: 'main' is protected…`). Merging a pull request is always allowed, even when direct pushes are not.
