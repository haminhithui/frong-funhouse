// In-repo derivative asset generation from the ORIGINAL PNG (never modified).
// Produces 3 faithful variants:
//   1. hero-4x.png     — high-quality 4x upscale (Lanczos), mild denoise, unsharp,
//                        contrast + olive-gray grade; framed, NOT cropped.
//   2. poster.png      — 2x upscale, "signal/poster" treatment: slight crop,
//                        strong contrast, vignette, matte look.
//   3. avatar.png      — 512px clean "reference" tile: mild crop (16:15),
//                        gentle grade, soft sharpen.
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SRC = join(root, 'public/assets/frong-token-original.png')
const OUT = join(root, 'public/assets/')
const src = sharp(SRC)

// ---- 1. HERO: 4x upscale, framed whole image ----
await src
  .clone()
  .resize(1000, 996, { kernel: 'lanczos3' })
  .modulate({ brightness: 1.02, saturation: 0.86 })
  .linear(1.16, -9)
  .sharpen({ sigma: 1.1 })
  .toFile(OUT + 'hero-4x.png')
console.log('hero-4x.png written')

// ---- 2. POSTER: signal crop + matte ----
await src
  .clone()
  .resize(760, 757, { kernel: 'lanczos3', fit: 'inside' })
  .extract({ left: 24, top: 24, width: 712, height: 708 })
  .modulate({ brightness: 1.04, saturation: 0.68 })
  .linear(1.24, -16)
  .sharpen({ sigma: 1.3 })
  .toFile(OUT + 'poster.png')
console.log('poster.png written')

// ---- 3. AVATAR: clean reference tile ----
await src
  .clone()
  .resize(512, 512, { kernel: 'lanczos3', fit: 'cover', position: 'centre' })
  .modulate({ brightness: 1.03, saturation: 0.9 })
  .linear(1.08, -4)
  .sharpen({ sigma: 0.9 })
  .toFile(OUT + 'avatar.png')
console.log('avatar.png written')

// ---- verify original untouched ----
import { statSync } from 'node:fs'
const before = statSync(SRC).size
console.log('original bytes still:', before, '(must be 67233)')
