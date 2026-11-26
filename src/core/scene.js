// Scene assembly: turn UI-level parameters into the concrete spectral pipeline.
// This is the single place that decides which proposal densities feed the
// accumulator, so the "sampling strategy" control has exactly one meaning.

import { SpectralData } from './spectral-data.js';
import { buildSource, solveLineWeightsToWhite, buildFilter, sceneWhiteOf } from './light.js';
import { makeGeometry, VIEW } from './geometry.js';
import { ExposureAccumulator } from './exposure.js';
import { DensitySampler, uniformSampler, energyDensityFn } from './sampling.js';
import { makeDisplayTransform, xyOfXyz, normalizeXyz } from './colorimetry.js';

export const NARROW_LINE_CENTERS = Object.freeze([450, 535, 620]);
export const NARROW_LINE_FWHM = 10;
export const WIDE_TEMPERATURE_K = 6500;

let cachedData = null;

export async function loadSpectralData(url) {
  if (!cachedData) cachedData = await SpectralData.load(url);
  return cachedData;
}

export function setSpectralData(data) {
  cachedData = data;
}

export function getSpectralData() {
  if (!cachedData) throw new Error('spectral data not loaded');
  return cachedData;
}

// Build the two lamps. The wide lamp is a Planck continuum; the narrow lamp is
// three Gaussian lines whose weights are solved so both integrate to the same
// white. This is the "same white appearance, very different spectrum" pair.
export function buildLamps(spectralData, { wideTemperatureK = WIDE_TEMPERATURE_K } = {}) {
  const wide = buildSource({ kind: 'continuous', temperatureK: wideTemperatureK, name: 'Wide-band (Planck)' });
  const white = sceneWhiteOf(wide, spectralData);
  const weights = solveLineWeightsToWhite(NARROW_LINE_CENTERS, NARROW_LINE_FWHM, spectralData, white);
  const narrow = buildSource({
    kind: 'lines',
    name: 'Narrow-band (3 lines)',
    lines: NARROW_LINE_CENTERS.map((centerNm, i) => ({
      centerNm,
      fwhmNm: NARROW_LINE_FWHM,
      weight: weights[i],
    })),
  });
  return { wide, narrow, white, narrowWeights: weights };
}

export function sourceById(lamps, id) {
  return id === 'narrow' ? lamps.narrow : lamps.wide;
}

// Build the wavelength proposal for a scene.
//  - 'uniform'  : flat over the window; filter-agnostic. This is the fixed
//                 wavelength layering baseline (independent, constant density).
//  - 'energy'   : source x geometry throughput x current filter x ybar. Because
//                 it is conditioned on the active filter, changing to a distant
//                 passband leaves the old samples with no support exactly there;
//                 that is what the accumulate/re-estimate path must detect, not
//                 paper over. The proposal is recorded with its density, so MIS
//                 reweighting of old samples stays unbiased.
//  - 'joint'    : source x geometry throughput x current filter x (x+y+z). This is
//                 the restricted correlated proposal: it conditions on both the
//                 source and the observer, so it clusters samples where the
//                 detected energy is. It uses the full CMF sum rather than ybar
//                 alone so the blue and red channels are not starved — a ybar-only
//                 density is exactly the shortcut that raises chromaticity error on
//                 broad spectra. The production render can use it, not just the
//                 experiment.
export function makeProposal(source, spectralData, strategy, { geometry, filter, lambdaMin, lambdaMax }) {
  if (strategy === 'uniform') {
    return uniformSampler(lambdaMin, lambdaMax, { resolution: 0.25 });
  }
  if (strategy === 'joint') {
    const fn = (lambda) => {
      const L = source.spd(lambda);
      if (!(L > 0)) return 0;
      const tr = geometry.trace(lambda);
      if (!tr.ok || !(tr.T > 0)) return 0;
      const f = filter ? filter.transmission(lambda) : 1;
      if (!(f > 0)) return 0;
      const cmf = spectralData.cmf(lambda);
      return L * tr.T * f * (cmf[0] + cmf[1] + cmf[2]);
    };
    return new DensitySampler(fn, { lambdaMin, lambdaMax, resolution: 0.25, kind: 'joint' });
  }
  const fn = energyDensityFn(source, spectralData, {
    geometry,
    filter,
    includeFilter: true,
    lambdaMin,
    lambdaMax,
  });
  return new DensitySampler(fn, { lambdaMin, lambdaMax, resolution: 0.25, kind: 'energy' });
}

export function createScene(spectralData, params) {
  const {
    lamp = 'wide',
    filter: filterSpec = { kind: 'clear' },
    optics = 'prism',
    material = 'N-BK7',
    dispersionModel = 'catalogue',
    apexDeg = 60,
    incidenceDeg = 49,
    entryFraction = 0.5,
    sampling = 'uniform',
    samples = 4000,
    seed = 1234,
    lambdaMin = 380,
    lambdaMax = 780,
    accumulate = true,
    previousAccumulator = null,
    lamps = null,
  } = params;

  const pair = lamps ?? buildLamps(spectralData);
  const source = sourceById(pair, lamp);
  const filter = buildFilter(filterSpec);
  const geometry = makeGeometry({ optics, material, spectralData, dispersionModel, apexDeg, incidenceDeg, entryFraction });

  // Scene white is the unfiltered light as seen through the current optics, so
  // the display transform keeps an unfiltered image neutral.
  const sceneWhite = integrateSceneWhite(source, spectralData, geometry, lambdaMin, lambdaMax);
  const display = makeDisplayTransform(sceneWhite);

  const accumulator = accumulate && previousAccumulator
    ? previousAccumulator
    : new ExposureAccumulator({ source, spectralData, geometry, lambdaMin, lambdaMax });

  return {
    spectralData,
    lamps: pair,
    source,
    filter,
    geometry,
    sceneWhite,
    display,
    accumulator,
    params: { ...params, lamp, filter: filterSpec, optics, material, apexDeg, incidenceDeg, sampling, samples, lambdaMin, lambdaMax },
    sampling: { strategy: sampling, samples, seed },
  };
}

// Integrate the unfiltered source through the geometry for the scene white.
function integrateSceneWhite(source, spectralData, geometry, lambdaMin, lambdaMax) {
  const step = 0.25;
  const n = Math.round((lambdaMax - lambdaMin) / step);
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i <= n; i++) {
    const lambda = lambdaMin + i * step;
    const tr = geometry.trace(lambda);
    if (!tr.ok || !(tr.T > 0)) continue;
    const L = source.spd(lambda);
    const cmf = spectralData.cmf(lambda);
    const w = (i === 0 || i === n ? 0.5 : 1) * step * L * tr.T;
    X += w * cmf[0];
    Y += w * cmf[1];
    Z += w * cmf[2];
  }
  return Y > 0 ? normalizeXyz([X, Y, Z]) : [1, 1, 1];
}

export { VIEW, xyOfXyz };
