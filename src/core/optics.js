// Geometric optics for a dispersive prism in its principal section.
// Coordinates: +x right, +y up. Angles are in radians internally, fields that
// expose them to the UI are suffixed with Deg. All failure modes are explicit;
// nothing is silently treated as black.

const DEG = Math.PI / 180;

// Sellmeier equation for transparent Schott glasses (refractiveindex.info
// "formula 2"): n^2 = 1 + K + sum_i B_i l^2 / (l^2 - C_i), with the coefficient
// list ordered [K, B1, C1, B2, C2, B3, C3] and l in micrometres.
export function sellmeierIndex(lambdaNm, coeffs) {
  const l2 = (lambdaNm / 1000) ** 2;
  const [K, B1, C1, B2, C2, B3, C3] = coeffs;
  return Math.sqrt(
    1 + K
      + (B1 * l2) / (l2 - C1)
      + (B2 * l2) / (l2 - C2)
      + (B3 * l2) / (l2 - C3),
  );
}

export const DISPERSION_MODELS = Object.freeze(['catalogue', 'constant']);

export function makeMaterial(name, spectralData, { model = 'catalogue' } = {}) {
  if (name === 'vacuum') {
    return { name: 'vacuum', nd: 1, n: () => 1, rangeUm: [0.36, 0.83], model: 'vacuum' };
  }
  const glass = spectralData.glasses[name];
  if (!glass) throw new Error(`unknown glass ${name}`);
  const nd = glass.nd;
  if (model === 'constant') {
    return { name, nd, n: () => nd, rangeUm: glass.rangeUm, model: 'constant', source: glass.source };
  }
  return {
    name,
    nd,
    n: (lambdaNm) => sellmeierIndex(lambdaNm, glass.sellmeier),
    rangeUm: glass.rangeUm,
    model: 'catalogue',
    source: glass.source,
  };
}

// Unpolarized power transmittance for a dielectric interface. cosThetaI is the
// cosine of the angle from the surface normal in the incident medium.
export function fresnelTransmittance(n1, n2, cosThetaI) {
  const c = Math.min(1, Math.abs(cosThetaI));
  const sin2t = (n1 / n2) ** 2 * (1 - c * c);
  if (sin2t >= 1) return 0;
  const cosT = Math.sqrt(1 - sin2t);
  const rs = (n1 * c - n2 * cosT) / (n1 * c + n2 * cosT);
  const rp = (n2 * c - n1 * cosT) / (n2 * c + n1 * cosT);
  return 1 - 0.5 * (rs * rs + rp * rp);
}

// Refract a direction through an interface. `normal` points into the incident
// medium along the surface normal, so dot(d, normal) < 0. eta = n_incident/n_out.
export function refract(d, normal, eta) {
  const cosI = -(d[0] * normal[0] + d[1] * normal[1]);
  if (!(cosI > 0)) return { tir: true, reason: 'normal-mismatch' };
  const sin2t = eta * eta * (1 - cosI * cosI);
  if (sin2t > 1) return { tir: true, sin2t };
  const cosT = Math.sqrt(1 - sin2t);
  const k = eta * cosI - cosT;
  const tx = eta * d[0] + k * normal[0];
  const ty = eta * d[1] + k * normal[1];
  const len = Math.hypot(tx, ty);
  return { tir: false, dir: [tx / len, ty / len], cosI, cosT, sin2t };
}

// Internal angle at which the exit ray goes evanescent (exit TIR).
export function criticalInternalAngle(nFrom, nTo) {
  if (nFrom <= nTo) return NaN;
  return Math.asin(nTo / nFrom);
}

// Deviation of a symmetric prism from Snell's law at both faces. Positive means
// the emergent ray is rotated counter-clockwise from the incident ray (upward in
// this scene's y-up coordinates).
export function analyticDeviationDeg(n, apexDeg, incidenceDeg) {
  const A = apexDeg * DEG;
  const i1 = incidenceDeg * DEG;
  const sinR1 = Math.sin(i1) / n;
  if (Math.abs(sinR1) >= 1) return null;
  const r1 = Math.asin(sinR1);
  const r2 = A - r1;
  const sinI2 = n * Math.sin(r2);
  if (Math.abs(sinI2) >= 1) return null;
  // Incident direction is measured relative to the left normal, so the unsigned
  // deviation is (i1 + i2 - A); in this geometry the ray bends downward.
  return -(i1 + Math.asin(sinI2) - A) / DEG;
}

export function minimumDeviationIncidenceDeg(n, apexDeg) {
  const v = n * Math.sin((apexDeg * DEG) / 2);
  return v <= 1 ? Math.asin(v) / DEG : NaN;
}

export function prismVertices(params) {
  const { apexDeg, faceLength } = params;
  const s = Math.sin((apexDeg * DEG) / 2);
  const c = Math.cos((apexDeg * DEG) / 2);
  return {
    apex: [0, 0],
    left: [-s * faceLength, -c * faceLength],
    right: [s * faceLength, -c * faceLength],
  };
}

function intersectRaySegment(origin, d, p0, p1) {
  const ex = p1[0] - p0[0];
  const ey = p1[1] - p0[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-12) return null;
  const ox = p0[0] - origin[0];
  const oy = p0[1] - origin[1];
  const t = (ox * ey - oy * ex) / den;
  const s = (ox * d[1] - oy * d[0]) / den;
  if (t <= 1e-9 || s < -1e-9 || s > 1 + 1e-9) return null;
  return { t, s, point: [origin[0] + t * d[0], origin[1] + t * d[1]] };
}

// Trace one wavelength through a triangular prism.
// The entry direction is set by the incidence angle measured from the left-face
// outward normal. Returns {ok:false, reason} for TIR, misses, or bad geometry.
export function tracePrism(lambdaNm, material, params) {
  const { apexDeg, incidenceDeg, faceLength, entryFraction = 0.5, screenX } = params;
  const A = apexDeg * DEG;
  const { apex, left, right } = prismVertices(params);
  const n = material.n(lambdaNm);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'index-undefined', lambdaNm };

  const c = Math.cos(A / 2);
  const s = Math.sin(A / 2);
  // Outward normals (point away from the glass) and inward normals.
  const nLeftOut = [-c, s];
  const nLeftIn = [c, -s];
  const nRightOut = [c, s];
  const nRightIn = [-c, -s];

  // Incoming direction: mirror of the left inward normal rotated by incidence.
  const beamAngle = incidenceDeg * DEG - A / 2;
  const dIn = [Math.cos(beamAngle), Math.sin(beamAngle)];

  const entry = [left[0] * entryFraction, left[1] * entryFraction];
  const r1 = refract(dIn, nLeftOut, 1 / n);
  if (r1.tir) return { ok: false, reason: 'tir-entry', lambdaNm, n };

  const exitHit = intersectRaySegment(entry, r1.dir, apex, right);
  if (!exitHit) return { ok: false, reason: 'no-exit-face', lambdaNm, n };
  if (exitHit.s > 1 - 1e-9) return { ok: false, reason: 'exit-at-apex', lambdaNm, n };
  const exit = exitHit.point;

  const r2 = refract(r1.dir, nRightIn, n);
  if (r2.tir) return { ok: false, reason: 'tir-exit', lambdaNm, n };

  const T = fresnelTransmittance(1, n, r1.cosI) * fresnelTransmittance(n, 1, r2.cosI);
  const dOut = r2.dir;

  let screenHit = null;
  if (Number.isFinite(screenX)) {
    const denom = dOut[0];
    if (Math.abs(denom) > 1e-9) {
      const t = (screenX - exit[0]) / denom;
      if (t > 0) screenHit = [screenX, exit[1] + t * dOut[1]];
    }
  }

  const deviationDeg = Math.atan2(
    dIn[0] * dOut[1] - dIn[1] * dOut[0],
    dIn[0] * dOut[0] + dIn[1] * dOut[1],
  ) / DEG;

  return {
    ok: true,
    lambdaNm,
    n,
    path: [entry, exit, ...(screenHit ? [screenHit] : [])],
    entry,
    exit,
    screenHit,
    dIn,
    dInternal: r1.dir,
    dOut,
    T,
    deviationDeg,
    exitAngleDeg: Math.asin(Math.min(1, Math.abs(Math.sin(Math.acos(Math.min(1, Math.abs(r2.cosI))))))) / DEG,
  };
}

// Straight reference path through a non-dispersive medium. The path is the same
// for every wavelength; the medium may impart a fixed absorption.
export function traceStraight(lambdaNm, params) {
  const { screenX, beamY = 0, absorbance = 0 } = params;
  return {
    ok: true,
    lambdaNm,
    n: 1,
    path: [[0, beamY], [screenX, beamY]],
    entry: [0, beamY],
    exit: [screenX, beamY],
    dIn: [1, 0],
    dInternal: [1, 0],
    dOut: [1, 0],
    screenHit: [screenX, beamY],
    T: Math.exp(-absorbance),
    deviationDeg: 0,
  };
}

export { DEG };
