// Independent reference integration, deliberately not sharing code with the
// sampling/accumulator path. It scans wavelength at a fine uniform step and
// integrates source * geometry throughput * filter * observer directly. This is
// what the exposure estimate is checked against, so bugs in MIS, CDFs or
// stratification cannot hide inside the reference.
//
// The same scan also produces the screen line positions: the exact y coordinate
// a wavelength lands at, plus the centroid of each emission line after filtering.

import { makeGrid } from './light.js';

export function referenceScan({
  source,
  spectralData,
  geometry,
  filter = null,
  lambdaMin = 380,
  lambdaMax = 780,
  step = 0.1,
  screenBins = 480,
}) {
  const grid = makeGrid(lambdaMin, lambdaMax, step);
  const rows = [];
  let X = 0, Y = 0, Z = 0;
  let transmitted = 0;
  let blocked = 0;
  let minScreenY = Infinity;
  let maxScreenY = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const lambda = grid[i];
    const L = source.spd(lambda);
    const f = filter ? filter.transmission(lambda) : 1;
    if (!(L > 0) || !(f > 0)) continue;
    const tr = geometry.trace(lambda);
    if (!tr.ok || !(tr.T > 0)) {
      blocked += 1;
      continue;
    }
    const cmf = spectralData.cmf(lambda);
    const w = (i === 0 || i === grid.length - 1 ? 0.5 : 1) * step;
    const scale = L * tr.T * f * w;
    X += scale * cmf[0];
    Y += scale * cmf[1];
    Z += scale * cmf[2];
    transmitted += scale;
    if (tr.screenHit) {
      minScreenY = Math.min(minScreenY, tr.screenHit[1]);
      maxScreenY = Math.max(maxScreenY, tr.screenHit[1]);
    }
    rows.push({
      lambda,
      L,
      f,
      T: tr.T,
      n: tr.n,
      screenY: tr.screenHit ? tr.screenHit[1] : null,
      deviationDeg: tr.deviationDeg ?? 0,
      scale,
      cmf,
    });
  }

  const screen = null;
  return {
    xyz: [X, Y, Z],
    rows,
    blockedSamples: blocked,
    screenRange: Number.isFinite(minScreenY) ? [minScreenY, maxScreenY] : null,
  };
}

// Exact screen-image integration: for each y bin, integrate the transmitted
// spectral radiance whose wavelength lands there. This is the reference the
// accumulated screen image is compared against, independent of sample weights.
export function referenceScreen({
  source,
  spectralData,
  geometry,
  filter = null,
  lambdaMin = 380,
  lambdaMax = 780,
  step = 0.05,
  yMin,
  yMax,
  bins = 480,
}) {
  const edges = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) edges[i] = yMin + ((yMax - yMin) * i) / bins;
  const xyz = Array.from({ length: bins }, () => [0, 0, 0]);
  const grid = makeGrid(lambdaMin, lambdaMax, step);
  for (let i = 0; i < grid.length; i++) {
    const lambda = grid[i];
    const L = source.spd(lambda);
    const f = filter ? filter.transmission(lambda) : 1;
    if (!(L > 0) || !(f > 0)) continue;
    const tr = geometry.trace(lambda);
    if (!tr.ok || !(tr.T > 0) || !tr.screenHit) continue;
    const idx = findBin(tr.screenHit[1], edges);
    if (idx < 0) continue;
    const cmf = spectralData.cmf(lambda);
    const w = (i === 0 || i === grid.length - 1 ? 0.5 : 1) * step;
    const scale = L * tr.T * f * w;
    xyz[idx][0] += scale * cmf[0];
    xyz[idx][1] += scale * cmf[1];
    xyz[idx][2] += scale * cmf[2];
  }
  return { edges, xyz };
}

function findBin(value, edges) {
  if (!(value >= edges[0] && value <= edges[edges.length - 1])) return -1;
  let lo = 0;
  let hi = edges.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= value) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Locate the transmitted emission lines after filtering: centroid wavelength and
// centroid screen position, found from the fine scan restricted to connected
// runs above a fraction of the local maximum. Used to verify line positions.
export function lineCentroids(scan, { thresholdFraction = 0.05 } = {}) {
  const pts = scan.rows.filter((r) => r.scale > 0 && r.screenY !== null);
  if (pts.length === 0) return [];
  const peak = Math.max(...pts.map((r) => r.L * r.T * r.f));
  const keep = pts.filter((r) => r.L * r.T * r.f >= thresholdFraction * peak);
  const groups = [];
  let current = [];
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i];
    const prev = current[current.length - 1];
    if (prev && r.lambda - prev.lambda > 1.5) {
      groups.push(current);
      current = [];
    }
    current.push(r);
  }
  if (current.length) groups.push(current);
  return groups.map((g) => {
    let ws = 0, wl = 0, wy = 0, wn = 0;
    for (const r of g) {
      const w = r.scale;
      ws += w;
      wl += w * r.lambda;
      wy += w * (r.screenY ?? 0);
      wn += w * r.n;
    }
    return {
      lambda: wl / ws,
      screenY: wy / ws,
      n: wn / ws,
      energy: ws,
      widthNm: g[g.length - 1].lambda - g[0].lambda,
    };
  });
}
