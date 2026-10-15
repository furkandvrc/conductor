---
name: image
description: Generate game art, icons, sprites, illustrations and other images straight into the project with Gemini's image model through the Antigravity CLI, instead of the user copy-pasting prompts into a chat app. Requires `agy`. Trigger on "generate an image", "draw an icon", "sprite", "make an asset", "illustration", "app icon", "görsel üret", "ikon çiz", "asset çiz".
---

# Image: generate straight into the project

```bash
gen-image "<prompt>" <path/to/out.png> [--transparent] [--variants N] [--timeout SEC]
```

- Runs through `agy` (Antigravity CLI) on the user's Google quota. A run takes about 20–60 s.
- `--transparent` asks for a white background and removes it with rembg (run through `uvx`),
  producing a real alpha PNG. It needs a `.png` output and `uv` installed. Use it for sprites and
  icons that sit on top of other art.
- `--variants 3` keeps the candidates as `out.png`, `out-2.png` and `out-3.png`. Keep one and
  delete the rest.
- Output format: `.png`, `.jpg` or `.webp`. Conversion uses `sips` on macOS or ImageMagick
  elsewhere.

## Workflow

1. **Write a concrete prompt.** Give the subject, the style (look at one existing asset first and
   match it), the view or angle, the palette and the background. Say "no text" unless text is
   wanted.
2. **Save it where the project keeps assets.** Follow the existing structure and naming, and
   register the file if the project requires it (for example a pubspec entry or an engine
   import).
3. **Look at the image yourself before reporting.** If it is off, regenerate with a sharper
   prompt. Resize when the project needs a specific size: `sips -Z <px>` on macOS, or
   `magick in.png -resize <px> out.png` elsewhere.
4. **If it fails** with "no image appeared", rerun once with a longer `--timeout`; Antigravity's
   image subagent sometimes queues. If `agy` is missing, say so; do not fall back to drawing images
   with code.
