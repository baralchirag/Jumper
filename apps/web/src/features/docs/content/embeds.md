# Badges and board previews

Show a board's status where people already look: the README on Jumper or GitHub, a project website, a wiki. Open a repository and choose **Embed** next to the **Code** button for ready-to-paste snippets.

## Check badges

```markdown
[![Checks](https://jumper.example.com/api/repos/acme/power-board/badge.svg)](https://jumper.example.com/acme/power-board/checks)
```

| URL | Shows |
| --- | --- |
| `…/badge.svg` | All checks on the latest commit: *passing*, *failing*, *running* or *warnings* |
| `…/badge.svg?check=DRC` | One check: `ERC`, `DRC`, `BOM`, `Render` or `Exports` |
| `…/badge.svg?branch=dev` | Another branch (default: the repository's default branch) |
| `…/badge.svg?label=rules` | Your own text on the left |
| `…/badge/release.svg` | The latest release's tag |

## Board preview

```markdown
![Power board](https://jumper.example.com/api/repos/acme/power-board/preview.png)
```

The picture comes from the checks on the newest commit that has one, so it updates on its own after each push. Choose the view with `?view=`:

- `iso` (default): a ray-traced 3D render at an angle
- `top` / `bottom`: straight-on 3D renders of each side
- `drawing`: the layout drawing (SVG), as on the repository page

If 3D renders are turned off in [`.jumper.yml`](/docs/jumper-yml), the preview falls back to the drawing.

## Private repositories

Badges and previews of private repositories load only for people signed in to Jumper who can read the repository, for example in the repository's own README. Elsewhere they return *not found*: they never reveal anything about a private repository.

For downloads rather than pictures, see the stable links on [Releases](/docs/releases).
