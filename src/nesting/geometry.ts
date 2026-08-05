export type Point = [number, number];
export type Polygon = Point[]; // implicitly closed: edge from last point back to first

export const EPS = 1e-7;

export function polygonSignedArea(poly: Polygon): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function polygonArea(poly: Polygon): number {
  return Math.abs(polygonSignedArea(poly));
}

// Area of an outline with holes cut out of it (holes are assumed non-overlapping and inside the outline).
export function netArea(outline: Polygon, holes: Polygon[] = []): number {
  return polygonArea(outline) - holes.reduce((sum, h) => sum + polygonArea(h), 0);
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export function boundingBox(poly: Polygon): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function centroid(poly: Polygon): Point {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    const sx = poly.reduce((s, p) => s + p[0], 0);
    const sy = poly.reduce((s, p) => s + p[1], 0);
    return [sx / n, sy / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function translate(poly: Polygon, dx: number, dy: number): Polygon {
  return poly.map(([x, y]) => [x + dx, y + dy] as Point);
}

// Translates poly so its bounding-box min corner lands exactly on `anchor`.
export function placeAtAnchor(poly: Polygon, anchor: Point): Polygon {
  const bb = boundingBox(poly);
  return translate(poly, anchor[0] - bb.minX, anchor[1] - bb.minY);
}

export function rotateAround(poly: Polygon, angleDeg: number, origin: Point): Polygon {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const [ox, oy] = origin;
  return poly.map(([x, y]) => {
    const dx = x - ox, dy = y - oy;
    return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos] as Point;
  });
}

export function rotateAroundCentroid(poly: Polygon, angleDeg: number): Polygon {
  if (angleDeg % 360 === 0) return poly;
  return rotateAround(poly, angleDeg, centroid(poly));
}

function orientation(a: Point, b: Point, c: Point): number {
  const val = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(val) < EPS) return 0;
  return val > 0 ? 1 : -1;
}

// Strict crossing test: touching endpoints/edges do NOT count as an intersection.
// This is deliberate — nesting wants parts to be able to sit flush against each other.
export function segmentsProperlyIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

export function pointInPolygon(pt: Point, poly: Polygon): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// True if the two polygons' interiors overlap. Polygons that merely touch (shared edge/vertex,
// no interior penetration) are NOT considered overlapping.
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  const bboxA = boundingBox(a);
  const bboxB = boundingBox(b);
  if (
    bboxA.maxX < bboxB.minX - EPS || bboxB.maxX < bboxA.minX - EPS ||
    bboxA.maxY < bboxB.minY - EPS || bboxB.maxY < bboxA.minY - EPS
  ) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }
  // No edge crossings: either fully separate, or one fully contains the other.
  if (pointInPolygon(a[0], b)) return true;
  if (pointInPolygon(b[0], a)) return true;
  return false;
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq < EPS ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function segmentDistance(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (segmentsProperlyIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

// Minimum distance between two polygons' boundaries. Returns 0 if they touch or overlap.
export function polygonMinDistance(a: Polygon, b: Polygon): number {
  if (polygonsOverlap(a, b)) return 0;
  let min = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      const d = segmentDistance(a1, a2, b1, b2);
      if (d < min) min = d;
      if (min <= EPS) return 0;
    }
  }
  return min;
}
