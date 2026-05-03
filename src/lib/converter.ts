import sharp from 'sharp'
import potrace from 'potrace'
import quantize from 'quantize'
import { fitPrimitivesInSvg } from './fit-primitives'

export interface ConversionOptions {
  colors?: number
  turdSize?: number
  smoothing?: number
  maxSize?: number
  debug?: boolean
}

export interface ConversionResult {
  svg: string           // final assembled SVG
  palette: string[]     // hex colors in draw order (lightest first)
  layers: string[]      // individual single-color SVG per palette entry
  width: number
  height: number
}

type RGB = [number, number, number]

// ── Perceptual color math ─────────────────────────────────────────────────────

// Precompute sRGB → linear lookup (avoids Math.pow per pixel)
const SRGB_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  SRGB_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = SRGB_LINEAR[r], lg = SRGB_LINEAR[g], lb = SRGB_LINEAR[b]
  // Linear RGB → XYZ (D65), normalize by white point
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y =  lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labDist(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number
): number {
  return (L1-L2)**2 + (a1-a2)**2 + (b1-b2)**2  // sqrt omitted — only used for comparison
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')
}

// ── Potrace wrapper ───────────────────────────────────────────────────────────

function traceBuffer(pngBuffer: Buffer, color: string, turdSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    potrace.trace(pngBuffer, {
      color,
      threshold: 128,
      turdSize,
      alphaMax: 1.3333,  // max corner rounding
      optCurve: true,
      optTolerance: 0.6, // aggressively merge nearby anchors into clean bezier spans
    }, (err: Error | null, svg: string) => {
      if (err) return reject(err)
      resolve(svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1]?.trim() ?? '')
    })
  })
}

// ── Main conversion ───────────────────────────────────────────────────────────

export async function convertImageToSvg(
  imageBuffer: Buffer,
  opts: ConversionOptions = {}
): Promise<ConversionResult> {
  const { colors = 16, turdSize = 2, smoothing = 1, maxSize = 900 } = opts

  // ── 1. Preprocess ────────────────────────────────────────────────────────────
  // Median(5) kills antialiased fringe pixels (up to ~2px wide) before
  // quantization so they don't bleed into dark/outline color buckets.
  const preprocessed = await sharp(imageBuffer)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace('srgb')
    .median(5)
    .png()
    .toBuffer()

  const { width, height } = await sharp(preprocessed).metadata()
  if (!width || !height) throw new Error('Could not read image dimensions')

  const { data: rawData } = await sharp(preprocessed).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })

  const totalPixels = width * height
  const pixelArray: RGB[] = new Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    pixelArray[i] = [rawData[i * 3], rawData[i * 3 + 1], rawData[i * 3 + 2]]
  }

  // ── 2. Generate palette via median-cut ───────────────────────────────────────
  const colorCount = Math.max(2, Math.min(colors, 100))
  const colorMap = quantize(pixelArray, colorCount)
  if (!colorMap) throw new Error('Quantization failed — image may be a single color')
  const palette: RGB[] = colorMap.palette()

  // ── 3. Assign pixels using CIE Lab distance (perceptually uniform) ───────────
  // RGB Euclidean treats yellow/green as far apart but they look similar to the
  // eye. Lab space matches perception, so edge pixels land in the right bucket.
  const paletteLab = palette.map(([r, g, b]) => rgbToLab(r, g, b))
  const pixelPaletteIdx = new Uint8Array(totalPixels)

  for (let i = 0; i < totalPixels; i++) {
    const [r, g, b] = pixelArray[i]
    const [L, A, B] = rgbToLab(r, g, b)
    let minDist = Infinity, nearest = 0
    for (let j = 0; j < paletteLab.length; j++) {
      const d = labDist(L, A, B, paletteLab[j][0], paletteLab[j][1], paletteLab[j][2])
      if (d < minDist) { minDist = d; nearest = j }
    }
    pixelPaletteIdx[i] = nearest
  }

  // ── 4. Count pixels per palette entry — used to detect fringe layers ────────
  // Fringe colors (blended edge pixels) are dark AND cover very few pixels.
  // Real fills and intentional outlines cover enough area to distinguish them.
  const paletteCounts = new Int32Array(palette.length)
  for (let i = 0; i < totalPixels; i++) paletteCounts[pixelPaletteIdx[i]]++

  // ── 5. Sort layers: largest area first (painter's algorithm), dark last ────────
  // Sort non-dark layers by pixel count descending: biggest shapes paint first,
  // smaller shapes (highlights, bubbles) paint on top naturally — no cutouts needed.
  // Dark outlines (lum < 50) always go last regardless of area.
  const sortedPalette = palette
    .map((c, idx) => ({ c, idx, lum: luminance(c[0], c[1], c[2]) }))
    .sort((a, b) => {
      const aDark = a.lum < 50
      const bDark = b.lum < 50
      if (aDark !== bDark) return aDark ? 1 : -1              // dark always last
      return paletteCounts[b.idx] - paletteCounts[a.idx]      // largest area first
    })

  // ── 6. Per-color: mask → expand/erode → smooth → trace ──────────────────────
  const layers: string[] = []
  const layerColors: string[] = []
  const layerSvgs: string[] = []

  const svgWrap = (inner: string, hex: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="display:block;width:100%;height:auto"><g>${inner.replace(/fill="[^"]*"/, `fill="${hex}"`)}</g></svg>`

  // Painter's algorithm: each non-dark layer should be a solid filled shape.
  // Pre-compute each palette entry's draw position so the mask loop can check
  // whether a pixel belongs to a "later" layer.
  const palettePositions = new Uint8Array(palette.length)
  sortedPalette.forEach(({ idx }, pos) => { palettePositions[idx] = pos })

  for (let sortedIdx = 0; sortedIdx < sortedPalette.length; sortedIdx++) {
    const { c, idx, lum } = sortedPalette[sortedIdx]

    const maskRaw = Buffer.alloc(totalPixels * 3)
    for (let i = 0; i < totalPixels; i++) {
      const assignedIdx = pixelPaletteIdx[i]
      // Non-dark layers: include own pixels + pixels from any later layer.
      // Those later-layer pixels will be painted over by subsequent layers,
      // so filling them now makes each shape solid with no holes.
      // Dark layers (outlines) only cover their own pixels — they're topmost.
      const include = (lum < 50)
        ? assignedIdx === idx
        : (assignedIdx === idx || palettePositions[assignedIdx] > sortedIdx)
      const v = include ? 0 : 255
      maskRaw[i * 3] = v; maskRaw[i * 3 + 1] = v; maskRaw[i * 3 + 2] = v
    }

    const isDarkLayer = lum < 50
    const isMediumDark = lum < 80

    // Three mask treatments:
    //   medium-dark (50–80 lum): aggressive erosion — blur(2)+threshold(50).
    //     Thin 1–3px fringe rings disappear (blurred from both sides, average > 50).
    //     Solid filled regions (mouth, eyes) have dense centers that survive.
    //   dark (lum < 50, thick outlines): mild erosion — blur(1)+threshold(70).
    //   light (lum ≥ 80): expand ~1px so fills close any gaps between layers.
    let pipeline = isMediumDark && !isDarkLayer
      ? sharp(maskRaw, { raw: { width, height, channels: 3 } }).blur(2.0).threshold(50)
      : isDarkLayer
        ? sharp(maskRaw, { raw: { width, height, channels: 3 } }).blur(1.0).threshold(70)
        : sharp(maskRaw, { raw: { width, height, channels: 3 } }).blur(1.0).threshold(185)

    if (!isMediumDark && smoothing > 0) {
      const softSigma = Math.min(Math.max(smoothing * 0.25, 0.3), 1.5)
      pipeline = (pipeline as ReturnType<typeof sharp>)
        .blur(softSigma)
        .threshold(128) as ReturnType<typeof sharp>
    }

    const maskPng = await (pipeline as ReturnType<typeof sharp>).png().toBuffer()

    try {
      const hex = rgbToHex(c[0], c[1], c[2])
      const layerTurdSize = isDarkLayer ? Math.max(turdSize * 2, 4) : turdSize
      const raw   = await traceBuffer(maskPng, hex, layerTurdSize)
      const inner = raw ? fitPrimitivesInSvg(raw, hex) : raw
      if (inner) {
        layers.push(inner)
        layerColors.push(hex)
        layerSvgs.push(svgWrap(inner, hex))
      }
    } catch { /* skip failed layers */ }
  }

  if (layers.length === 0) throw new Error('No vector paths could be traced from this image')

  // ── 6. Assemble SVG ──────────────────────────────────────────────────────────
  const body = layers.map(l => `  <g>${l}</g>`).join('\n')
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="0 0 ${width} ${height}"`,
    `     style="display:block;width:100%;height:auto">`,
    body,
    `</svg>`,
  ].join('\n')

  return { svg, palette: layerColors, layers: layerSvgs, width, height }
}
