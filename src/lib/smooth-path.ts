// Post-process SVG path data: simplify redundant anchors then refit smooth
// Catmull-Rom splines. Two-pass algorithm:
//   1. Douglas-Peucker — removes points whose perpendicular deviation from the
//      chord between neighbours is below epsilon. Collapses over-sampled runs.
//   2. Catmull-Rom → cubic bezier — guarantees C1 continuity (tangents match
//      at every junction) so there are no kinks between segments.

interface Point { x: number; y: number }

interface Subpath {
  pts: Point[]
  closed: boolean
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-10) return Math.hypot(p.x - a.x, p.y - a.y)
  // Project p onto ab, clamp to segment, measure orthogonal distance
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

function douglasPeucker(pts: Point[], eps: number): Point[] {
  if (pts.length <= 2) return pts
  let maxD = 0, idx = 1
  const last = pts.length - 1
  for (let i = 1; i < last; i++) {
    const d = perpDist(pts[i], pts[0], pts[last])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > eps) {
    return [
      ...douglasPeucker(pts.slice(0, idx + 1), eps).slice(0, -1),
      ...douglasPeucker(pts.slice(idx), eps),
    ]
  }
  return [pts[0], pts[last]]
}

// ── Catmull-Rom → cubic bezier ────────────────────────────────────────────────
// Tangent at point i:  T[i] = alpha * (P[i+1] - P[i-1])
// Bezier CP1 for segment i→j:  P[i] + T[i]/3
// Bezier CP2 for segment i→j:  P[j] - T[j]/3
// This guarantees C1 continuity — tangents match at every junction, no kinks.

function catmullRomPath(pts: Point[], closed: boolean, alpha = 0.5): string {
  const n = pts.length
  if (n < 2) return ''

  const T: Point[] = new Array(n)
  for (let i = 0; i < n; i++) {
    if (closed) {
      const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n]
      T[i] = { x: alpha * (next.x - prev.x), y: alpha * (next.y - prev.y) }
    } else if (i === 0) {
      T[i] = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }
    } else if (i === n - 1) {
      T[i] = { x: pts[n-1].x - pts[n-2].x, y: pts[n-1].y - pts[n-2].y }
    } else {
      T[i] = { x: alpha * (pts[i+1].x - pts[i-1].x), y: alpha * (pts[i+1].y - pts[i-1].y) }
    }
  }

  const f = (v: number) => +v.toFixed(3)
  const parts = [`M ${f(pts[0].x)} ${f(pts[0].y)}`]

  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    parts.push(
      `C ${f(pts[i].x + T[i].x / 3)} ${f(pts[i].y + T[i].y / 3)}` +
      ` ${f(pts[j].x - T[j].x / 3)} ${f(pts[j].y - T[j].y / 3)}` +
      ` ${f(pts[j].x)} ${f(pts[j].y)}`
    )
  }
  if (closed) parts.push('Z')
  return parts.join(' ')
}

// ── SVG path parser ───────────────────────────────────────────────────────────
// Handles M, C, c, L, l, Z/z. Discards bezier control points — we only
// keep the on-curve endpoints since we're refitting the curves anyway.

function parsePath(d: string): Subpath[] {
  const subpaths: Subpath[] = []
  const tokens = d.match(/[MmCcLlZzHhVv]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []

  let i = 0, curX = 0, curY = 0, startX = 0, startY = 0
  let current: Point[] = []

  const num = () => parseFloat(tokens[i++])

  const flush = (closed: boolean) => {
    if (current.length >= 2) subpaths.push({ pts: [...current], closed })
    current = []
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
          num(); num(); num(); num()           // skip control points
          curX = num(); curY = num()
          current.push({ x: curX, y: curY })
        }
        break
      }
      case 'c': {
        while (i < tokens.length && /^[-+\d.]/.test(tokens[i])) {
          num(); num(); num(); num()           // skip relative control points
          curX += num(); curY += num()
          current.push({ x: curX, y: curY })
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
        // Remove duplicate end=start point before marking closed
        if (current.length > 0) {
          const last = current[current.length - 1]
          if (Math.abs(last.x - startX) < 0.5 && Math.abs(last.y - startY) < 0.5) {
            current.pop()
          }
        }
        flush(true)
        curX = startX; curY = startY
        break
      }
    }
  }
  flush(false)
  return subpaths
}

// ── Public API ────────────────────────────────────────────────────────────────

export function smoothPathD(d: string, epsilon: number, alpha = 0.5): string {
  if (epsilon <= 0 || !d) return d
  const subpaths = parsePath(d)
  return subpaths.map(({ pts, closed }) => {
    if (pts.length < 2) return ''
    // Keep at least 3 points so the Catmull-Rom pass has something to work with
    const simplified = pts.length >= 3 ? douglasPeucker(pts, epsilon) : pts
    const safe = simplified.length >= 2 ? simplified : pts.slice(0, 2)
    return catmullRomPath(safe, closed, alpha)
  }).filter(Boolean).join(' ')
}

// Replace every d="..." in a block of inner SVG markup
export function smoothSvgInner(inner: string, epsilon: number): string {
  if (epsilon <= 0) return inner
  return inner.replace(/\bd="([^"]+)"/g, (_, d) => `d="${smoothPathD(d, epsilon)}"`)
}
