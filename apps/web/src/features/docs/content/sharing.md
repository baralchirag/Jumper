# Share links

A share link lets someone **without an account** view a read-only snapshot of a repository — a client reviewing a design, or a fab house checking your files.

## Creating a link

Settings → **Share links** (repository admins only):

* **Revision** – a branch, tag or commit. A branch link follows the branch; a commit link is a fixed snapshot.
* **Limit to folder or file** – share only `hardware/rev-b` and nothing else.
* **Expires** – 1 to 90 days, or never. Prefer an expiry.
* **Allow downloads** – off means files can only be viewed in the browser.
* **Watermark** – text tiled over the shared page, e.g. “Confidential — ACME”.

The full link is shown **once**. Jumper stores only a hash, so a lost link cannot be recovered; create another.

## What viewers can see

The shared page shows the file tree (restricted to your folder), text files, images, PDFs and the renders and reports produced by checks. Active content such as HTML and scripts is never displayed inline.

## Revoking

Revoke a link from the same page and it stops working immediately. Links also stop working if the person who created them is disabled or the repository is deleted.

## Limits to be aware of

* Anyone holding the link can use it. Treat it like a password.
* *View-only* means the browser UI offers no download. A determined viewer can still copy what the page displays, and a watermark deters rather than prevents leaks. Do not share anything you cannot afford to be copied.
* Every view is counted; the link list shows views and last access.
