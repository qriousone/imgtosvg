// Geometric primitive fitting for traced SVG paths.
//
// Strategy: for each <path> element produced by Potrace, densely sample the
// cubic bezier curves to get an accurate polygon approximation, then compute
// the isoperimetric quotient Q = 4π·A / P².  Q = 1 for a perfect circle;
// anything above CIRCLE_Q (0.82) is round enough to replace with <circle>.
//
// Sampling is necessary because Potrace represents circles with only 4–6
// cubic bezier segments. Using only the on-curve endpoints (as the simpler
// parsePath does) gives a pentagon/hexagon whose Q ≈ 0.77, which would miss
// real circles. Sampling 10 pts/segment brings Q to >0.999 for true circles.

interface Point { x: number; y: number }

const CIRCLE_Q = 0.82   // isoperimetric quotient threshold
const MIN_R    = 3      // ignore circles smaller than 3px radius
const MAX_R    = 600    // ignore implausibly large "circles"
const SAMPLES  = 10     // bezier samples per segment

// ── Bezier dense sampler ──────────────────────────────────────────────────────

function denseSample(d: string): { pts: Point[]; closed: boolean }[] {
  const subpaths: { pts: Point[]; closed: boolean }[] = []
  const tokens = d.match(/[MmCcLlZzHhVv]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []

  let i = 0, curX = 0, curY = 0, startX = 0, startY = 0
  let current: Point[] = []

  const num = () => parseFloat(tokens[i++])

  const flush = (closed: boolean) => {
    if (current.length >= 3) subpaths.push({ pts: [...current], closed })
    current = []
  }

  const cubic = (x0: number, y0: number, cx1: number, cy1: number,
                  cx2: number, cy2: number, x1: number, y1: number) => {
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES, u = 1 - t
      current.push({
        x: u*u*u*x0 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x1,
        y: u*u*u*y0 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y1,
      })
    }
    curX = x1; curY = y1
  }

  while (i < tokens.length) {
    const cmd = tokens[i++]
    switch (cmd) {
      case 'M': {
        flush(false)
        curX = num(); curY = num()
        startX = curX; startY = curY
        current = [{ x: curX, y: curY }]
        break
      }
      case 'm': {
        flush(false)
        curX += num(); curY += num()
        startX = curX; startY = curY
        current = [{ x: curX, y: curY }]
        break
      }
      case 'C': {
        while (i < tokens.length && /^[-+\d.]/.test(tokens[i])) {
          const cx1 = num(), cy1 = num(), cx2 = num(), cy2 = num()
          const x1 = num(), y1 = num()
          cubic(curX, curY, cx1, cy1, cx2, cy2, x1, y1)
        }
        break
      }
      case 'c': {
        while (i < tokens.length && /^[-+\d.]/.test(tokens[i])) {
          const cx1 = curX + num(), cy1 = curY + num()
          const cx2 = curX + num(), cy2 = curY + num()
          const x1  = curX + num(), y1  = curY + num()
          cubic(curX, curY, cx1, cy1, cx2, cy2, x1, y1)
        }
        break
      }
      case 'L': {
        while (i < tokens.length && /^[-+\d.]/.test(tokens[i])) {
          curX = num(); curY = num()
          current.push({ x: curX, y: curY })
        }
        break
      }
      case 'l': {
        while (i < tokens.length && /^[-+\d.]/.test(tokens[i])) {
          curX += num(); curY += num()
          current.push({ x: curX, y: curY })
        }
        break
      }
      case 'Z': case 'z': {
        flush(true)
        curX = startX; curY = startY
        break
      }
    }
  }
  flush(false)
  return subpaths
}

// ── Geometry ──────────────────────────────────────────────────────────────────

function shoelaceArea(pts: Point[]): number {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a) / 2
}

function polyPerim(pts: Point[]): number {
  let p = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y
    p += Math.sqrt(dx * dx + dy * dy)
  }
  return p
}

function centroid(pts: Point[]): Point {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const F = (v: number) => +v.toFixed(2)

// For each <path> in the SVG inner markup: if every subpath within that path
// is circular (Q ≥ CIRCLE_Q), replace the entire element with <circle> tags.
// If any subpath is non-circular the original path element is kept untouched.
export function fitPrimitivesInSvg(inner: string, fill: string): string {
  return inner.replace(/<path\b[^>]*>/g, match => {
    const dMatch = match.match(/\bd="([^"]+)"/)
    if (!dMatch) return match

    const subpaths = denseSample(dMatch[1])
    if (subpaths.length === 0) return match

    const circles: string[] = []

    for (const { pts, closed } of subpaths) {
      if (!closed || pts.length < 8) return match

      const area  = shoelaceArea(pts)
      const perim = polyPerim(pts)
      if (perim < 4) return match

      const Q = (4 * Math.PI * area) / (perim * perim)
      if (Q < CIRCLE_Q) return match

      const c = centroid(pts)
      const r = Math.sqrt(area / Math.PI)
      if (r < MIN_R || r > MAX_R) return match

      circles.push(`<circle cx="${F(c.x)}" cy="${F(c.y)}" r="${F(r)}" fill="${fill}"/>`)
    }

    return circles.join('\n')
  })
}
