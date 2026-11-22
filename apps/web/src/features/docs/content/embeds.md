# Badges and board previews

You can show a board's check status or a picture of it in a README or on a website. Open a repository and click **Embed** next to **Code** to copy a snippet.

## Check badge

```markdown
[![Checks](https://jumper.example.com/api/repos/acme/power-board/badge.svg)](https://jumper.example.com/acme/power-board/checks)
```

| URL                         | Shows                                         |
| --------------------------- | --------------------------------------------- |
| `…/badge.svg`               | All checks on the latest commit               |
| `…/badge.svg?check=DRC`     | One check: `ERC`, `DRC`, `BOM`, `Render` or `Exports` |
| `…/badge.svg?branch=dev`    | Another branch                                |
| `…/badge.svg?label=rules`   | Your own label                                |

## Board preview

```markdown
![Power board](https://jumper.example.com/api/repos/acme/power-board/preview.png)
```

The picture updates after each push. Pick the view with `?view=`:

- `iso` (default): 3D render at an angle
- `top` or `bottom`: 3D render of one side
- `drawing`: the layout drawing

If 3D renders are turned off, the preview uses the drawing.

## Private repositories

Badges and previews of private repositories only load for signed-in people who can read the repository. Everyone else gets *not found*.
