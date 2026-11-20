# Markdown

READMEs and comments use **GitHub-flavoured Markdown**, sanitized before it is shown. This page is itself rendered with it.

## Text

| You type                  | You get                 |
| ------------------------- | ----------------------- |
| `**bold**`                | **bold**                |
| `_italic_`                | _italic_                |
| `~~struck~~`              | ~~struck~~              |
| `` `code` ``              | `code`                  |
| `<kbd>Ctrl</kbd>`         | <kbd>Ctrl</kbd>         |
| `H<sub>2</sub>O`, `x<sup>2</sup>` | H<sub>2</sub>O, x<sup>2</sup> |
| `:rocket: :tada: :zap:`   | :rocket: :tada: :zap:   |

In the editor, <kbd>Ctrl</kbd> <kbd>B</kbd>, <kbd>Ctrl</kbd> <kbd>I</kbd>, <kbd>Ctrl</kbd> <kbd>E</kbd> and <kbd>Ctrl</kbd> <kbd>K</kbd> format the selection, and <kbd>Ctrl</kbd> <kbd>Enter</kbd> submits.

## Headings and anchors

Every heading gets an anchor. Hover one and click `#` to copy a link to the section.

## Lists and tasks

1. Route the USB pair
2. Pour ground on both layers
   - stitch vias every 5 mm
   - keep the antenna keep-out clear

- [x] ERC clean
- [x] DRC clean
- [ ] order rev B

## Alerts

> [!NOTE]
> Plain information the reader should notice.

> [!TIP]
> A better way of doing something.

> [!IMPORTANT]
> Something needed to succeed.

> [!WARNING]
> Needs immediate attention to avoid problems.

> [!CAUTION]
> Risky: may damage the board or the bench supply.

## Code

Fenced blocks are highlighted for `sh`, `yaml`, `json`, `js`/`ts`, `python`, `c`/`cpp`, `rust`, `toml`, `diff` and KiCad S-expressions (`kicad`).

```yaml
checks:
  drc:
    enabled: true
    fail_on: error
```

```kicad
(footprint "Resistor_SMD:R_0402_1005Metric"
  (layer "F.Cu")
  (at 112.5 64.25 90)
  (property "Reference" "R7"))
```

```diff
- (via (at 110 60) (size 0.6) (drill 0.3))
+ (via (at 110 60) (size 0.45) (drill 0.2))
```

## References

- `@username` links to a profile, like @design-qa
- Relative links and images in a README resolve inside the repository: `![top](docs/top.png)`

## Collapsible sections

<details>
<summary>Stack-up</summary>

| Layer | Material      | Thickness |
| ----- | ------------- | --------: |
| F.Cu  | Copper 1 oz   |  0.035 mm |
| Core  | FR-4          |  1.51 mm  |
| B.Cu  | Copper 1 oz   |  0.035 mm |

</details>

## What is removed

Scripts, styles, iframes, forms and event handlers are stripped. External links open in a new tab with `rel="nofollow noopener"`.
