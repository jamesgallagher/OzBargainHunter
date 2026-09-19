# Logo

`logo.svg` is the master. Everything else is derived from it.

## The mark

A gold coin that is also a bird of prey. The disc is both the coin and the
cranium; the hooked beak is the only thing that breaks the circle, which is
what keeps the silhouette distinctive at icon sizes. It degrades on purpose:
at 32px it is a sharp gold predator, and the coin reading arrives at 256px and
above.

## Palette

| Role         | Hex       | Contrast on `#1C1C1C` |
| ------------ | --------- | --------------------- |
| Lit gold     | `#FFC44F` | 10.8:1                |
| Shadow gold  | `#DD8519` | 6.0:1                 |
| Eye          | `#221304` | — (6.5:1 against the shadow gold) |

The two golds are only a 1.8:1 step apart so they average into one coin at
32px instead of fragmenting the silhouette. Warm gold is also deliberate
positioning: the Unraid dashboard is overwhelmingly blue and teal.

## Constraints this must keep satisfying

From `design.md` §10.7: square, legible at 32px, no text in the mark, no
hairline strokes, readable on a dark background, transparent background, and
no resemblance to OzBargain's own branding. The mark is fills only — there is
no stroke anywhere, so nothing thins away on downscale. The eye is a solid
fill rather than a knockout, so it stays a hole on light backgrounds too.

## Regenerating the PNGs

```sh
ffmpeg -y -width 512 -height 512 -i logo.svg -frames:v 1 -pix_fmt rgba icon-512.png
ffmpeg -y -width 256 -height 256 -i logo.svg -frames:v 1 -pix_fmt rgba icon-256.png
```

Any librsvg-backed rasteriser works; `rsvg-convert -w 512 -h 512` is the
direct equivalent. Keep `-pix_fmt rgba` — without it the alpha is flattened
and the icon ships with a black square behind it.

`icon-256.png` is the file the Unraid template's `<Icon>` field points at, so
it needs hosting somewhere reachable (Open Item O15).

The favicon derivatives named in §10.7 are not built yet.
