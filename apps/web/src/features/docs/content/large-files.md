# Large files (Git LFS)

KiCad files are text, so plain git handles them well. But some files that go with a board are big: STEP models, datasheets, photos. [Git LFS](https://git-lfs.com) stores those on the server and keeps only a small pointer in git.

Every Jumper repository has LFS. You don't need to turn anything on.

## Set it up

Install Git LFS once (`brew install git-lfs` or `apt install git-lfs`). Then in your project:

```sh
git lfs install
git lfs track "*.step" "*.stp" "*.wrl" "*.pdf" "*.jpg" "*.png"
git add .gitattributes
git commit -m "Use Git LFS for models and datasheets"
git push
```

Matching files are now uploaded when you push and downloaded when you clone. It works over HTTPS and SSH.

> [!NOTE]
> Don't put `.kicad_sch`, `.kicad_pcb`, `.kicad_sym` or `.kicad_mod` files in LFS. Jumper needs them in plain git to diff and check them.

## Files already in history

`git lfs track` only affects new commits. To move old files, run:

```sh
git lfs migrate import --include="*.step" --everything
```

Then force-push. Everyone has to clone again after this.

## Limits

- One file can be up to 2 GB. The admin can change this.
- Anyone who can read the repository can download its LFS files. Anyone who can push can upload.
- Each file is checked against its SHA-256 on upload.
