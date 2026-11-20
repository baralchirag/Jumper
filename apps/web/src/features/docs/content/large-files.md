# Large files (Git LFS)

KiCad projects are text and belong in plain git. Some files that travel with a board are big binaries, though: STEP models of connectors and enclosures, datasheets, photos of the assembled board, test captures. Committing them directly makes every clone download every version forever. [Git LFS](https://git-lfs.com) stores them on the server instead and keeps only small pointers in git.

Jumper runs an LFS server for every repository. There is nothing to turn on.

## Set up a repository

Install Git LFS once per computer (`brew install git-lfs`, `apt install git-lfs`, or the installer from git-lfs.com), then in your project:

```sh
git lfs install
git lfs track "*.step" "*.stp" "*.wrl" "*.pdf" "*.jpg" "*.png"
git add .gitattributes
git commit -m "Store 3D models, datasheets and photos with Git LFS"
git push
```

From then on, matching files are uploaded to LFS when you push and downloaded when you clone or pull. It works over HTTPS (your access token) and SSH (your key) without extra configuration.

> [!NOTE]
> Keep `.kicad_sch`, `.kicad_pcb`, `.kicad_sym` and `.kicad_mod` files out of LFS. They are text: in plain git, Jumper can diff them, render them and run checks on them.

## Moving existing files into LFS

`git lfs track` only affects new commits. To move files that are already in the history, rewrite it with `git lfs migrate import --include="*.step" --everything`, then force-push. Everyone must clone again afterwards, so agree on a time with your team first.

## Limits

- One file can be up to **2 GB** (your administrator may set another limit).
- LFS files count towards your plan's storage, next to repositories and generated outputs. See [Settings → Usage and plan](/settings/usage).
- When a push would exceed the storage in your plan, the upload is refused before anything is sent, with a message saying so.


## Permissions

The same rules as git: anyone who can read the repository can download its LFS files, and anyone who can push can upload. Every file is checked against its SHA-256 on upload, so a damaged or tampered upload is rejected.
