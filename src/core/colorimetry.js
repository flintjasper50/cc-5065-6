// Colorimetry, the CIE observer integration, and the auditable output transform.
// The display transform is a single documented step: relative scene XYZ ->
// Bradford adaptation from the scene white to D65 -> linear sRGB -> sRGB transfer.
// Nothing here is wavelength-specific; spectral power never becomes an RGB label
// except through this transform or through the explicitly-separate label ramp.

import { OBSERVER_RANGE } from './spectral-data.js';

export const XYZ_TO_LINEAR_SRGB = Object.freeze([
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.2040, 1.0570],
]);

export const D65_WHITE = Object.freeze([0.95047, 1.0, 1.08883]);

// Bradford cone response matrix (used for chromatic adaptation).
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mul3(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

export function mulMat3(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return out;
}

export function inverse3(A) {
  const [a, b, c] = A[0];
  const [d, e, f] = A[1];
  const [g, h, i] = A[2];
  const A00 = e * i - f * h;
  const A01 = -(d * i - f * g);
  const A02 = d * h - e * g;
  const det = a * A00 + b * A01 + c * A02;
  if (Math.abs(det) < 1e-15) throw new Error('singular matrix');
  const inv = 1 / det;
  return [
    [A00 * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [A01 * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [A02 * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

// Bradford adaptation matrix taking srcWhite to dstWhite.
export function bradfordAdaptation(srcWhite, dstWhite = D65_WHITE) {
  const src = mul3(BRADFORD, srcWhite);
  const dst = mul3(BRADFORD, dstWhite);
  const scale = [
    [dst[0] / src[0], 0, 0],
    [0, dst[1] / src[1], 0],
    [0, 0, dst[2] / src[2]],
  ];
  return mulMat3(inverse3(BRADFORD), mulMat3(scale, BRADFORD));
}

export function xyzToLinearSrgb([X, Y, Z]) {
  return mul3(XYZ_TO_LINEAR_SRGB, [X, Y, Z]);
}

export function srgbEncode(linear) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

export function srgbDecode(encoded) {
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
}

// Output transform for a complete viewing condition. `sceneWhite` is the XYZ of
// the unfiltered light as seen through the current optics; dividing by its Y and
// adapting to D65 makes an unfiltered white render neutral. Exposure is applied
// in linear light and is display-only.
export function makeDisplayTransform(sceneWhite, exposure = 1) {
  if (!(sceneWhite[1] > 0)) throw new Error('scene white has zero luminance');
  const adaptation = bradfordAdaptation(sceneWhite.map((v) => v / sceneWhite[1]));
  return {
    adaptation: adaptation.map((r) => r.slice()),
    exposure,
    white: sceneWhite.slice(),
    toSrgb(xyz) {
      const adapted = mul3(adaptation, xyz.map((v) => v / sceneWhite[1]));
      const linear = xyzToLinearSrgb(adapted).map((c) => Math.max(0, c * exposure));
      return {
        rgb: linear.map((c) => clamp01(srgbEncode(c))),
        linear,
        adapted,
      };
    },
  };
}

export function xyzToLab(xyz, white = D65_WHITE) {
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (t) => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
  const fx = f(xyz[0] / white[0]);
  const fy = f(xyz[1] / white[1]);
  const fz = f(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE76(a, b) {
  const la = xyzToLab(a);
  const lb = xyzToLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

export function xyOfXyz([X, Y, Z]) {
  const s = X + Y + Z;
  return s > 0 ? [X / s, Y / s] : [0, 0];
}

// Composite trapezoid over the observer grid. Out-of-observer wavelengths have
// exactly zero response (SpectralData.cmf policy), so the bounds are clamped.
export function integrateXyz(spd, spectralData, { lambdaMin, lambdaMax, step = 0.5 } = {}) {
  const lo = Math.max(lambdaMin ?? OBSERVER_RANGE[0], OBSERVER_RANGE[0]);
  const hi = Math.min(lambdaMax ?? OBSERVER_RANGE[1], OBSERVER_RANGE[1]);
  const n = Math.max(1, Math.round((hi - lo) / step));
  const h = (hi - lo) / n;
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i <= n; i++) {
    const lambda = lo + i * h;
    const s = spd(lambda);
    if (!(s > 0)) continue;
    const [x, y, z] = spectralData.cmf(lambda);
    const w = i === 0 || i === n ? 0.5 : 1;
    X += w * s * x;
    Y += w * s * y;
    Z += w * s * z;
  }
  return [X * h, Y * h, Z * h];
}

export function normalizeXyz(xyz) {
  const Y = xyz[1];
  return Y > 0 ? [xyz[0] / Y, 1, xyz[2] / Y] : [0, 0, 0];
}

// Display-only wavelength -> RGB label for axes and chips. It is derived from the
// same observer but normalized per wavelength for legibility; it is never used as
// the rendered image color. The rendered color is always the integrated XYZ.
export function wavelengthLabelRgb(lambda, spectralData) {
  const cmf = spectralData.cmf(lambda);
  const peak = Math.max(cmf[0], cmf[1], cmf[2]);
  if (peak <= 0) return [0, 0, 0];
  const norm = [cmf[0] / peak, cmf[1] / peak, cmf[2] / peak];
  const lin = xyzToLinearSrgb(norm).map((c) => Math.max(0, c));
  return lin.map((c) => clamp01(srgbEncode(c)));
}
