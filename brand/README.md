# Brand artwork

Approved Blue Pine Solutions Mail artwork, supplied by the operator. These masters are the source for the runtime copies; do not redraw, recolour or retouch them.

| Master | Size | Used for |
|---|---|---|
| `blue-pine-mail-logo-master.png` | 500 × 500, RGBA | Full logo (includes the "BLUE PINE / SOLUTIONS, LLC / MAIL" text) |
| `blue-pine-mail-mark-master.png` | 500 × 500, RGBA | App mark (no text) |

Runtime copies in `public/`, derived by resampling only:

- `brand/blue-pine-mail-logo.png` and `.webp`: the full logo at its native 500 × 500 (lossless; the master is below 640 px, so it is not upscaled).
- `icon-192.png`, `icon-96.png` and `favicon.ico` (16 × 16 and 32 × 32 PNG frames): the app mark, centred on a transparent square with an equal 4 % margin around the visible artwork (alpha above 8/255), downsampled with Lanczos. `/icon-96.png` is the default-icon path the branding API and fallbacks depend on; keep it.

The file names keep the technical `blue-pine-mail` form used by the repository and release tags.
