# Releases

A release marks the revision you sent to the fab and keeps its fabrication files with it. Months later, "which Gerbers did we order Rev B from?" has one answer.

## Create a release

Open the repository's **Releases** tab and choose **New release**:

1. **Tag**: name the revision, e.g. `rev-B` or `v1.2`. Pick an existing tag, or type a new one and choose the branch it is created from.
2. **Title and notes**: what changed since the last revision, known issues, assembly notes. Notes are Markdown.
3. **Fabrication files**: tick what to attach. They are copied from the check outputs of the tagged commit:

| File | Comes from |
| --- | --- |
| Gerbers and drill files | `outputs.gerbers` |
| JLCPCB order package | `outputs.fab_package: jlcpcb`: Gerbers, BOM and CPL in JLCPCB's column layout |
| Bill of materials | the schematic's BOM, as CSV |
| 3D model (STEP) | `outputs.step` |
| PDF | `outputs.pdf`: schematic and board drawings |
| Pick-and-place | `outputs.pos` |

If the checks for that commit are still running, the release is created anyway and the files are attached when the checks finish. Anything that cannot be generated is listed with the reason, for example an output turned off in [`.jumper.yml`](/docs/jumper-yml).

Save a **draft** to prepare a release privately. Only people with write access see drafts. Mark prototypes as **pre-release** so they are never shown as the latest release.

## Attach your own files

Use **Attach file** on a release for anything else that belongs to the revision: assembly drawings, test reports, firmware images, a signed-off PDF. Files can be up to 200 MB and count towards your storage.

## Stable download links

Every repository has links that always point to the latest release, for READMEs and order pages:

```text
/api/repos/OWNER/REPO/releases/latest/download/gerbers.zip
/api/repos/OWNER/REPO/releases/latest/download/jlcpcb.zip
/api/repos/OWNER/REPO/releases/latest/download/bom.csv
```

The name matches the end of a file name, so `gerbers.zip` finds `board-v1.2-gerbers.zip`. Private repositories still require access.

## Deleting

Deleting a release removes its files. You can choose to keep the git tag, so the revision stays marked in the history.
