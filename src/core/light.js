// Spectral light sources and filters. Each source exposes a *physical* spectral
// radiance L(lambda) in arbitrary but consistent power units, plus a sampling
// density. The source emission is never an RGB color; RGB enters only through the
// final observer integration in colorimetry.js.

import { integrateXyz, normalizeXyz } from './colorimetry.js';

export const PLANCK_H = 6.62607015e-34;
export const PLANCK_C = 2.99792458e8;
export const PLANCK_K = 1.380649e-23;

export function planckSpectralRadiance(lambdaNm, temperatureK) {
  const l = lambdaNm * 1e-9;
  const x = (PLANCK_H * PLANCK_C) / (l * PLANCK_K * temperatureK);
  if (x > 700) return 0;
  return (2 * PLANCK_H * PLANCK_C ** 2) / (l ** 5 * (Math.exp(x) - 1));
}

export function gaussianLine(lambdaNm, centerNm, fwhmNm) {
  if (!(fwhmNm > 0)) return lambdaNm === centerNm ? 1 : 0;
  const sigma = fwhmNm / (2 * Math.sqrt(2 * Math.LN2));
  const d = (lambdaNm - centerNm) / sigma;
  return Math.exp(-0.5 * d * d);
}

// A source is a list of named components with weights. Weights are chosen so the
// unfiltered source has the requested scene white; the *shape* (wide vs narrow
// spectrum) is what differs between the two lamps.
export function buildSource(spec) {
  const { kind, temperatureK = 6500, lines = [], name } = spec;
  if (kind === 'continuous') {
    return {
      name,
      kind,
      temperatureK,
      support: [360, 830],
      spd(lambdaNm) {
        return planckSpectralRadiance(lambdaNm, temperatureK);
      },
      components: [{ type: 'planck', temperatureK }],
    };
  }
  if (kind === 'lines') {
    return {
      name,
      kind,
      lines: lines.map((l) => ({ ...l })),
      support: [360, 830],
      spd(lambdaNm) {
        let s = 0;
        for (const line of lines) s += line.weight * gaussianLine(lambdaNm, line.centerNm, line.fwhmNm);
        return s;
      },
      components: lines.map((l) => ({
        type: 'gaussian',
        centerNm: l.centerNm,
        fwhmNm: l.fwhmNm,
        weight: l.weight,
      })),
    };
  }
  throw new Error(`unknown source kind ${kind}`);
}

// Solve per-line weights so that the line source integrates to the target XYZ
// exactly for the observer. This is what makes the two lamps *look* identical
// before the prism even though their spectra differ. The 3x3 system uses the
// XYZ integral of each unit-peak Gaussian as its basis.
export function solveLineWeightsToWhite(lineCenters, fwhmNm, spectralData, targetWhite, lambdaSet) {
  const grid = lambdaSet ?? makeGrid(380, 780, 0.25);
  const basis = lineCenters.map((centerNm) => {
    const spd = (l) => gaussianLine(l, centerNm, fwhmNm);
    return integrateXyz(spd, spectralData, { lambdaMin: grid[0], lambdaMax: grid.at(-1), step: 0.25 });
  });
  // A * w = target, with A[c][i] = basis[i][c].
  const A = [
    [basis[0][0], basis[1][0], basis[2][0]],
    [basis[0][1], basis[1][1], basis[2][1]],
    [basis[0][2], basis[1][2], basis[2][2]],
  ];
  const w = solve3(A, targetWhite);
  return w;
}

export function solve3(A, b) {
  const M = [A[0].slice(), A[1].slice(), A[2].slice()].map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let j = col; j < 4; j++) M[col][j] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j < 4; j++) M[r][j] -= f * M[col][j];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

export function makeGrid(lo, hi, step) {
  const n = Math.round((hi - lo) / step);
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = lo + i * step;
  return out;
}

// Filter profile. A band-pass is defined by a top-hat (with optional soft edges);
// a "clear" filter transmits everywhere. Transmission is a pure scalar per
// wavelength so it can be applied to cached samples without re-sampling.
export function buildFilter(spec) {
  const { kind, centerNm = 550, widthNm = 20, edgeSoftnessNm = 2, transmission = 1 } = spec;
  if (kind === 'clear') {
    return { kind, centerNm: 0, widthNm: Infinity, support: [380, 780], transmission: () => 1, describe: 'clear (no filter)' };
  }
  if (kind === 'bandpass') {
    const lo = centerNm - widthNm / 2;
    const hi = centerNm + widthNm / 2;
    const soft = Math.max(1e-6, edgeSoftnessNm);
    const edge = (x, a, b) => {
      // Smoothstep edges over +-soft around a and b.
      const s = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
      return s((x - (a - soft)) / (2 * soft)) * (1 - s((x - (b - soft)) / (2 * soft)));
    };
    return {
      kind,
      centerNm,
      widthNm,
      transmission: (l) => transmission * edge(l, lo, hi),
      support: [lo - soft, hi + soft],
      describe: `band-pass ${centerNm}nm +/-${widthNm / 2}nm`,
    };
  }
  throw new Error(`unknown filter kind ${kind}`);
}

// Convenience: is a wavelength inside the filter's support?
export function filterTransmits(filter, lambdaNm) {
  return filter.transmission(lambdaNm);
}

export function sceneWhiteOf(source, spectralData, lambdaMin = 380, lambdaMax = 780) {
  const xyz = integrateXyz(source.spd, spectralData, { lambdaMin, lambdaMax, step: 0.25 });
  return normalizeXyz(xyz);
}
