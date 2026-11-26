// Wavelength-strategy experiment: independent (fixed) wavelength layering
// versus restricted correlated sampling driven by the joint source and sensor
// response.
//
// The two strategies answer the same integral, ∫ L(λ)·T(λ)·filter(λ)·CMF(λ) dλ,
// with a different proposal density:
//
//   fixed  — independent, equal-probability strata over the whole window. The
//            density is constant, so the strata are fixed in λ regardless of the
//            source or the observer. This is the "fixed wavelength layering"
//            baseline. It is cheap (no proposal traces) and, because it spreads
//            samples over the full window, it never leaves a lit screen bin empty
//            at coarse resolution.
//
//   joint  — restricted correlated sampling: the proposal is the product of the
//            source SPD L(λ), the real traced path throughput T(λ), and the
//            sensor response ΣCMF(λ). The density is a function of both the light
//            and the observer, so samples cluster where the *detected* energy is.
//            Building that density costs one geometry trace per grid point
//            (~2× the ray cost of a fixed run), but it resolves sharp lines that
//            the fixed strata miss.
//
// Both proposals are recorded with their density, so the exposure accumulator's
// balance-heuristic MIS estimator stays unbiased for either.
//
// The descriptor that decides between them is the *participation width* W: the
// effective width in nm of L(λ)·T(λ)·ΣCMF(λ), i.e. how many nanometres actually
// carry the detected signal. Combined with the sample budget N it gives the
// expected number of samples that land in the effective support,
//
//     c = N·W / (λmax − λmin),
//
// which is the boundary condition this module calibrates. When c is large the
// fixed layering already resolves the spectrum; when c is small (a sharp line
// under a modest budget) only the joint response sampling resolves it, at a
// higher ray cost.
//
// Every number here is computed from real traces and the independent reference
// scan (reference.js), so the chromaticity error and ray cost in the report are
// reproducible by re-running the module — nothing is asserted from architecture.

import { DensitySampler, uniformSampler, mulberry32 } from './sampling.js';
import { ExposureAccumulator } from './exposure.js';
import { referenceScan, referenceScreen } from './reference.js';
import { deltaE76 } from './colorimetry.js';

export const STRATEGIES = Object.freeze(['fixed', 'joint']);

export const STRATEGY_LABELS = Object.freeze({
  fixed: 'fixed wavelength layering (independent, constant density)',
  joint: 'joint source+sensor response sampling (restricted, correlated)',
});

// Policy tolerances. The switching / sufficiency criterion uses exactly the two
// quantities the brief names: the colour error (global ΔE76 of the integrated
// display colour against the reference) and the dark-band coverage (the fraction
// of lit screen energy left in empty bins). ΔE76 of 1 is roughly a just-noticeable
// difference; 2% of the lit screen energy may be left empty before coverage is
// judged insufficient. These are design choices, stated so the rule can be audited.
export const DEFAULT_TOLERANCES = Object.freeze({
  colourDeltaE: 1.0,
  omission: 0.02,
});

// Scale a source so its photometric integral is 1. Makes the two contrast spectra
// comparable in exposure; the reported ΔE metrics are already scale-invariant but
// the SPD plot and omission weighting are easier to read normalised.
export function normalizedSource(source, spectralData, { lambdaMin = 380, lambdaMax = 780, step = 0.5 } = {}) {
  let y = 0;
  for (let l = lambdaMin; l <= lambdaMax; l += step) {
    y += source.spd(l) * spectralData.cmf(l)[1];
  }
  const k = y > 0 ? 1 / y : 1;
  return {
    ...source,
    spd: (l) => source.spd(l) * k,
    components: source.components,
    normalization: k,
  };
}

// Effective participation width in nm of L(λ)·T(λ)·ΣCMF(λ). A Planck continuum
// inside the window has W of order 200 nm; a 2 nm emission line has W of order a
// few nm. T(λ) comes from the real geometry, so a prism that clips part of the
// window reduces W the same way it reduces the detected energy.
export function participationWidth({ source, spectralData, geometry, lambdaMin = 380, lambdaMax = 780, step = 0.5 }) {
  let s = 0;
  let s2 = 0;
  for (let l = lambdaMin; l <= lambdaMax; l += step) {
    const L = source.spd(l);
    if (!(L > 0)) continue;
    const tr = geometry.trace(l);
    if (!tr.ok || !(tr.T > 0)) continue;
    const cmf = spectralData.cmf(l);
    const response = cmf[0] + cmf[1] + cmf[2];
    if (!(response > 0)) continue;
    const w = L * tr.T * response;
    s += w;
    s2 += w * w;
  }
  return s > 0 ? (s * s / s2) * step : 0;
}

// Expected number of independent samples landing inside the participation width
// under the fixed (uniform-over-window) layering.
export function concentration(samples, width, lambdaMin = 380, lambdaMax = 780) {
  return samples > 0 ? (samples * width) / (lambdaMax - lambdaMin) : 0;
}

// A geometry wrapper that counts calls to trace(), so the ray cost of a strategy
// is measured rather than estimated. The signature is preserved so the
// accumulator's trace cache behaves as in production.
export function countedGeometry(geometry) {
  const base = geometry;
  const wrapper = Object.assign(Object.create(Object.getPrototypeOf(geometry) ?? Object.prototype), geometry);
  wrapper.traceCount = 0;
  wrapper.trace = (lambda) => {
    wrapper.traceCount += 1;
    return base.trace(lambda);
  };
  return wrapper;
}

// Build the proposal for a strategy. The joint density is the product of the
// source, the traced throughput and the sensor response — all three, so it is a
// true "joint source and sensor" proposal and not a source-only shortcut that
// would starve the blue/red channels.
export function strategySampler(strategy, {
  source,
  spectralData,
  geometry,
  filter = null,
  lambdaMin = 380,
  lambdaMax = 780,
  resolution = 0.25,
}) {
  if (strategy === 'fixed') {
    return uniformSampler(lambdaMin, lambdaMax, { resolution });
  }
  if (strategy === 'joint') {
    const density = (lambda) => {
      const L = source.spd(lambda);
      if (!(L > 0)) return 0;
      const tr = geometry.trace(lambda);
      if (!tr.ok || !(tr.T > 0)) return 0;
      const f = filter ? filter.transmission(lambda) : 1;
      if (!(f > 0)) return 0;
      const cmf = spectralData.cmf(lambda);
      return L * tr.T * f * (cmf[0] + cmf[1] + cmf[2]);
    };
    return new DensitySampler(density, { lambdaMin, lambdaMax, resolution, kind: 'joint' });
  }
  throw new Error(`unknown strategy ${strategy}`);
}

export function buildScreenFromReference(reference, { count = 96, padFraction = 0.15 } = {}) {
  const range = reference.screenRange;
  if (!range) return null;
  const span = range[1] - range[0];
  const pad = Math.max(1e-3, span * padFraction);
  return { yMin: range[0] - pad, yMax: range[1] + pad, count };
}

// Run one strategy and measure it against the shared independent reference.
// `shared` carries the reference scan and screen image so both strategies are
// scored against exactly the same ground truth (the reference is not part of
// either strategy's ray cost).
export function runStrategy({
  source,
  spectralData,
  geometry,
  filter = null,
  strategy,
  samples,
  seed = 1234,
  screen,
  shared = null,
}) {
  const counted = countedGeometry(geometry);
  counted.traceCount = 0;
  const sampler = strategySampler(strategy, { source, spectralData, geometry: counted, filter });
  const proposalRays = counted.traceCount;

  counted.traceCount = 0;
  const accumulator = new ExposureAccumulator({ source, spectralData, geometry: counted, lambdaMin: 380, lambdaMax: 780 });
  const rng = mulberry32(seed);
  accumulator.addBatch(sampler, sampler.drawStratified(samples, rng, { jitter: true }), {
    filter,
    label: `${strategy} proposal`,
  });
  const estimate = accumulator.estimate(filter, screen ? { screen } : {});
  const estimateRays = counted.traceCount;

  const reference = shared?.reference ?? referenceScan({ source, spectralData, geometry, filter, step: 0.5 });
  const referenceImage = shared?.referenceImage
    ?? (screen ? referenceScreen({ source, spectralData, geometry, filter, step: 0.5, yMin: screen.yMin, yMax: screen.yMax, bins: screen.count }) : null);

  const metrics = scoreEstimate({ estimate, reference, referenceImage, screen });
  return { strategy, sampler, accumulator, estimate, metrics, proposalRays, estimateRays, rays: proposalRays + estimateRays, samples };
}

// Per-pixel accumulated spectral error and composite colour deviation.
//
//   globalDeltaE   — ΔE76 of the whole integrated XYZ against the reference.
//                    This is the single "display colour" error.
//   pixelDeltaE    — luminance-weighted RMS ΔE76 per screen bin. Each bin's XYZ
//                    is the wavelength integral landing there, so this is the
//                    per-pixel spectral error accumulated from the samples.
//   compositeDeltaE— sqrt(global² + pixel²): penalises getting the overall colour
//                    right by luck while the dispersion frame is wrong, and vice
//                    versa.
//   omission       — fraction of the lit reference screen energy that fell into
//                    bins the estimate left empty (no sample landed there). This
//                    is the dark-band omission: lost coverage, not zero energy.
export function scoreEstimate({ estimate, reference, referenceImage, screen }) {
  const estXyz = estimate.xyz;
  const refXyz = reference.xyz;
  const refLit = refXyz[1] > 0;
  const estLit = estXyz[1] > 0;
  const globalDeltaE = refLit && estLit ? deltaE76(normXyz(estXyz), normXyz(refXyz)) : (refLit ? Infinity : 0);

  let pixelDeltaE = Infinity;
  let omission = 0;
  let darkBins = 0;
  let litBins = 0;
  let binCoverage = 1;

  if (referenceImage && estimate.screen) {
    const refBins = referenceImage.xyz;
    let peak = 0;
    for (const v of refBins) peak = Math.max(peak, v[1]);
    let litY = 0;
    let omitY = 0;
    let sumW = 0;
    let sumDE2 = 0;
    for (let i = 0; i < refBins.length; i++) {
      const ry = refBins[i][1];
      if (!(ry > peak * 1e-4)) continue;
      litBins += 1;
      litY += ry;
      const bin = estimate.screen.bins[i];
      if (!bin || bin.count === 0) {
        omitY += ry;
        darkBins += 1;
        continue;
      }
      const est = bin.xyz;
      const ref = refBins[i];
      if (!(est[1] > 0) || !(ref[1] > 0)) {
        // A bin that received samples but no photometric energy cannot carry a
        // colour; count it as an error rather than silently dropping it.
        sumW += ry;
        sumDE2 += ry * 100;
        continue;
      }
      const dE = deltaE76(normXyz(est), normXyz(ref));
      sumW += ry;
      sumDE2 += ry * dE * dE;
    }
    pixelDeltaE = sumW > 0 ? Math.sqrt(sumDE2 / sumW) : Infinity;
    omission = litY > 0 ? omitY / litY : 0;
    binCoverage = litBins > 0 ? (litBins - darkBins) / litBins : 1;
  }

  const compositeDeltaE = Number.isFinite(globalDeltaE) && Number.isFinite(pixelDeltaE)
    ? Math.sqrt(globalDeltaE * globalDeltaE + pixelDeltaE * pixelDeltaE)
    : Infinity;

  return {
    globalDeltaE,
    pixelDeltaE,
    compositeDeltaE,
    omission,
    darkBins,
    litBins,
    binCoverage,
    bandCoverage: estimate.coverage ? estimate.coverage.supportedFraction : NaN,
    unresolved: estimate.coverage ? !estimate.coverage.supported : false,
  };
}

function normXyz([X, Y, Z]) {
  return Y > 0 ? [X / Y, 1, Z / Y] : [0, 0, 0];
}

// Per-screen-bin spectral error profile: the raw material behind pixelDeltaE,
// surfaced so the UI can mark which regions of the dispersion frame disagree.
export function perPixelError({ estimate, referenceImage }) {
  if (!referenceImage || !estimate.screen) return [];
  const refBins = referenceImage.xyz;
  let peak = 0;
  for (const v of refBins) peak = Math.max(peak, v[1]);
  const out = [];
  for (let i = 0; i < refBins.length; i++) {
    const ref = refBins[i];
    const bin = estimate.screen.bins[i];
    const lit = ref[1] > peak * 1e-4;
    let deltaE = null;
    let omitted = false;
    if (lit) {
      if (!bin || bin.count === 0) omitted = true;
      else if (ref[1] > 0 && bin.xyz[1] > 0) deltaE = deltaE76(normXyz(bin.xyz), normXyz(ref));
    }
    out.push({ index: i, y0: bin?.y0 ?? referenceImage.edges[i], y1: bin?.y1 ?? referenceImage.edges[i + 1], refY: ref[1], lit, omitted, deltaE });
  }
  return out;
}

// Measure one spectrum under both strategies against one shared reference, over a
// set of seeds. The *metrics* are averaged across seeds (Monte Carlo noise in the
// per-pixel error is large under a modest budget, so a single seed is not a fair
// score), while one representative run is kept for the UI to draw paths and the
// contribution table.
export function analyzeSpectrum({
  id,
  label,
  source,
  spectralData,
  geometry,
  filter = null,
  samples,
  seed = 1234,
  seeds = [11, 22, 33, 44, 55],
  screenBins = 192,
}) {
  const reference = referenceScan({ source, spectralData, geometry, filter, step: 0.25 });
  const screen = buildScreenFromReference(reference, { count: screenBins });
  const shared = { reference };
  if (screen) {
    shared.referenceImage = referenceScreen({
      source, spectralData, geometry, filter, step: 0.25,
      yMin: screen.yMin, yMax: screen.yMax, bins: screen.count,
    });
  }
  const width = participationWidth({ source, spectralData, geometry });
  const c = concentration(samples, width);

  const runs = {};
  for (const strategy of STRATEGIES) {
    const perSeed = seeds.map((s) =>
      runStrategy({ source, spectralData, geometry, filter, strategy, samples, seed: s, screen, shared }));
    const averaged = averageMetrics(perSeed.map((r) => r.metrics));
    // Representative run: the seed closest to the averaged global ΔE, so the UI
    // draws a typical sample set rather than the best or worst one.
    let rep = perSeed[0];
    let bestDist = Infinity;
    for (const r of perSeed) {
      const d = Math.abs(r.metrics.globalDeltaE - averaged.globalDeltaE);
      if (d < bestDist) { bestDist = d; rep = r; }
    }
    runs[strategy] = {
      ...rep,
      metrics: averaged,
      seedMetrics: perSeed.map((r) => r.metrics),
      seeds,
    };
  }
  const pixelErrors = {};
  for (const strategy of STRATEGIES) {
    pixelErrors[strategy] = perPixelError({ estimate: runs[strategy].estimate, referenceImage: shared.referenceImage });
  }

  return {
    id, label, source, geometry, filter, samples, seed: seeds[0], seeds,
    width, concentration: c,
    screen,
    reference,
    runs,
    pixelErrors,
    referenceImage: shared.referenceImage,
  };
}

function averageMetrics(list) {
  const keys = ['globalDeltaE', 'pixelDeltaE', 'compositeDeltaE', 'omission', 'binCoverage', 'bandCoverage'];
  const out = {};
  for (const k of keys) {
    const vals = list.map((m) => m[k]).filter((v) => Number.isFinite(v));
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Infinity;
  }
  // Dark bins and counts are integer evidence; take the mean as a rate.
  out.darkBins = list.reduce((a, m) => a + m.darkBins, 0) / list.length;
  out.litBins = list[0]?.litBins ?? 0;
  out.unresolved = list.some((m) => m.unresolved);
  return out;
}

// Does a run meet the policy? Used only on calibration data to label a spectrum
// as "fixed is sufficient"; never consulted to make a blind decision. The label
// is the AND of the two tolerances the brief specifies — colour error and
// dark-band coverage — both averaged over the seed set.
export function meetsTolerance(run, tolerances = DEFAULT_TOLERANCES) {
  const m = run.metrics;
  return m.globalDeltaE <= tolerances.colourDeltaE
    && m.omission <= tolerances.omission;
}

// Calibrate the boundary condition on the calibration half. The rule is
//   decision(spectrum) = concentration >= cStar ? 'fixed' : 'joint'
// i.e. use fixed layering when the budget already resolves the participation
// width, otherwise switch to the joint response sampling. cStar is chosen to
// misclassify as few calibration spectra as possible, then to minimise the total
// ray cost of the resulting decisions.
export function calibrateRule(calibrationSpectra, { tolerances = DEFAULT_TOLERANCES } = {}) {
  const points = calibrationSpectra.map((s) => {
    const fixedSufficient = meetsTolerance(s.runs.fixed, tolerances);
    const jointSufficient = meetsTolerance(s.runs.joint, tolerances);
    const target = fixedSufficient ? 'fixed' : 'joint';
    return {
      id: s.id,
      label: s.label,
      concentration: s.concentration,
      width: s.width,
      fixedSufficient,
      jointSufficient,
      target,
      fixed: s.runs.fixed.metrics,
      joint: s.runs.joint.metrics,
      fixedRays: s.runs.fixed.rays,
      jointRays: s.runs.joint.rays,
    };
  });

  const candidates = [];
  const cs = points.map((p) => p.concentration).sort((a, b) => a - b);
  if (cs.length === 0) return { cStar: 0, points, candidates, tolerances };
  // Candidate thresholds: just below the smallest, between every pair, just above
  // the largest. A threshold at or above the largest c means "always fixed".
  candidates.push(cs[0] - 1e-9);
  for (let i = 1; i < cs.length; i++) candidates.push((cs[i - 1] + cs[i]) / 2);
  candidates.push(cs[cs.length - 1] + 1e-9);

  let best = null;
  for (const cStar of candidates) {
    let errors = 0;
    let rays = 0;
    for (const p of points) {
      const decision = p.concentration >= cStar ? 'fixed' : 'joint';
      if (decision !== p.target) errors += 1;
      rays += decision === 'fixed' ? p.fixedRays : p.jointRays;
    }
    const score = { cStar, errors, rays };
    if (!best || errors < best.errors || (errors === best.errors && rays < best.rays)) best = score;
  }
  return { cStar: best.cStar, errors: best.errors, totalRays: best.rays, points, candidates, tolerances };
}

// Apply a calibrated rule to unseen (blind) spectra and report, honestly, what
// each strategy costs and where the rule lands relative to the measured outcome.
// The decision uses only the descriptor and cStar; the metrics are computed for
// every strategy afterwards to report the comparison, not to choose.
export function evaluateRule(rule, blindSpectra, { tolerances = DEFAULT_TOLERANCES } = {}) {
  const rows = blindSpectra.map((s) => {
    const fixedSufficient = meetsTolerance(s.runs.fixed, tolerances);
    const jointSufficient = meetsTolerance(s.runs.joint, tolerances);
    const target = fixedSufficient ? 'fixed' : 'joint';
    const decision = s.concentration >= rule.cStar ? 'fixed' : 'joint';
    const chosen = s.runs[decision];
    const chosenSufficient = decision === 'fixed' ? fixedSufficient : jointSufficient;
    return {
      id: s.id,
      label: s.label,
      concentration: s.concentration,
      width: s.width,
      decision,
      target,
      agree: decision === target,
      chosenSufficient,
      fixedSufficient,
      jointSufficient,
      fixed: s.runs.fixed.metrics,
      joint: s.runs.joint.metrics,
      chosenMetrics: chosen.metrics,
      fixedRays: s.runs.fixed.rays,
      jointRays: s.runs.joint.rays,
      chosenRays: chosen.rays,
      omission: chosen.metrics.omission,
    };
  });
  return summarizeBlind(rows, tolerances);
}

function summarizeBlind(rows, tolerances) {
  const totalFixedRays = rows.reduce((a, r) => a + r.fixedRays, 0);
  const totalJointRays = rows.reduce((a, r) => a + r.jointRays, 0);
  const totalChosenRays = rows.reduce((a, r) => a + r.chosenRays, 0);
  const mean = (k, strategy) => {
    if (rows.length === 0) return NaN;
    return rows.reduce((a, r) => a + r[strategy][k], 0) / rows.length;
  };
  return {
    tolerance: tolerances,
    rows,
    summary: {
      n: rows.length,
      disagreements: rows.filter((r) => !r.agree).length,
      chosenSufficientCount: rows.filter((r) => r.chosenSufficient).length,
      fixedSufficientCount: rows.filter((r) => r.fixedSufficient).length,
      jointSufficientCount: rows.filter((r) => r.jointSufficient).length,
      meanFixedColourDeltaE: mean('globalDeltaE', 'fixed'),
      meanJointColourDeltaE: mean('globalDeltaE', 'joint'),
      meanFixedCompositeDeltaE: mean('compositeDeltaE', 'fixed'),
      meanJointCompositeDeltaE: mean('compositeDeltaE', 'joint'),
      meanFixedOmission: mean('omission', 'fixed'),
      meanJointOmission: mean('omission', 'joint'),
      totalFixedRays,
      totalJointRays,
      totalChosenRays,
      chosenRayRatioVsJoint: totalJointRays > 0 ? totalChosenRays / totalJointRays : NaN,
    },
  };
}
