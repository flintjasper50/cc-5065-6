// In-repo wavelength-strategy experiment.
//
// Two contrast sources with opposite peak widths are placed in the same prism
// geometry so dispersion acts on both:
//
//   "broad"  — a Planck continuum (peak width of order 200 nm). Its detected
//              energy is spread across the window, so fixed layering resolves it.
//   "sharp"  — a set of narrow Gaussian lines (peak width a few nm). Fixed
//              layering almost never lands on a line, so only joint response
//              sampling resolves it — at roughly twice the ray cost.
//
// The two families are arranged as a *paired ladder*: for each geometric mean
// width there is a broad member and a sharp member. The ladder is split into a
// calibration half and a blind half. The switching threshold is calibrated on the
// calibration half only; the blind half is then scored. No blind metric is read
// while choosing the threshold.
//
// Everything is deterministic given a seed, so the report is reproducible.

import { buildSource, buildFilter } from './light.js';
import { makeGeometry, VIEW } from './geometry.js';
import {
  normalizedSource,
  analyzeSpectrum,
  calibrateRule,
  evaluateRule,
  DEFAULT_TOLERANCES,
  STRATEGY_LABELS,
} from './strategies.js';

// Deterministic "sharp" source: lines at the classic three primaries. Weights are
// equal so the source is a clean line comb, not a tuned white; the two contrast
// spectra are deliberately *not* white-matched here — the comparison is about
// resolving the spectrum, and each is normalised on its own photometric integral.
function sharpSource(fwhmNm, centers = [450, 535, 620], label = '') {
  return buildSource({
    kind: 'lines',
    name: `sharp lines (${fwhmNm}nm${label})`,
    lines: centers.map((centerNm) => ({ centerNm, fwhmNm, weight: 1 })),
  });
}

// The spectrum ladder. Each entry is the pair at one "width position": a broad
// Planck continuum and a sharp line comb. The FWHM of the comb is chosen so the
// two are genuinely opposite in peak width at every rung.
export const SPECTRUM_FAMILY = Object.freeze([
  { id: 'broad-2700', kind: 'broad', temperatureK: 2700, label: 'broad 2700 K' },
  { id: 'sharp-2', kind: 'sharp', fwhmNm: 2, label: 'sharp FWHM 2 nm' },
  { id: 'broad-4000', kind: 'broad', temperatureK: 4000, label: 'broad 4000 K' },
  { id: 'sharp-4', kind: 'sharp', fwhmNm: 4, label: 'sharp FWHM 4 nm' },
  { id: 'broad-6500', kind: 'broad', temperatureK: 6500, label: 'broad 6500 K' },
  { id: 'sharp-8', kind: 'sharp', fwhmNm: 8, label: 'sharp FWHM 8 nm' },
  { id: 'broad-9500', kind: 'broad', temperatureK: 9500, label: 'broad 9500 K' },
  { id: 'sharp-14', kind: 'sharp', fwhmNm: 14, label: 'sharp FWHM 14 nm' },
  { id: 'broad-12000', kind: 'broad', temperatureK: 12000, label: 'broad 12000 K' },
  { id: 'sharp-22', kind: 'sharp', fwhmNm: 22, label: 'sharp FWHM 22 nm' },
  { id: 'sharp-40', kind: 'sharp', fwhmNm: 40, label: 'sharp FWHM 40 nm' },
  { id: 'sharp-70', kind: 'sharp', fwhmNm: 70, label: 'sharp FWHM 70 nm' },
]);

// Calibration vs blind split. Chosen by position, alternation included so neither
// half is all-broad or all-sharp. Fixed so the split is auditable in the report.
export const CALIBRATION_IDS = Object.freeze([
  'broad-2700', 'sharp-4', 'broad-6500', 'sharp-14', 'broad-12000', 'sharp-40',
]);
export const BLIND_IDS = Object.freeze([
  'sharp-2', 'broad-4000', 'sharp-8', 'broad-9500', 'sharp-22', 'sharp-70',
]);

export function buildFamilySource(entry, spectralData) {
  let raw;
  if (entry.kind === 'broad') {
    raw = buildSource({ kind: 'continuous', temperatureK: entry.temperatureK, name: `broad ${entry.temperatureK}K` });
  } else {
    raw = sharpSource(entry.fwhmNm);
  }
  return normalizedSource(raw, spectralData);
}

// The geometry is the repo's real prism, not a schematic: same Sellmeier glass,
// same vector trace, same screen plane as the renderer. N-SF11 at 50° incidence
// spreads the spectrum well enough that per-pixel error is meaningful.
export const EXPERIMENT_GEOMETRY = Object.freeze({
  optics: 'prism',
  material: 'N-SF11',
  dispersionModel: 'catalogue',
  apexDeg: 50,
  incidenceDeg: 40,
  entryFraction: 0.5,
});

export function experimentGeometry(spectralData) {
  return makeGeometry({ ...EXPERIMENT_GEOMETRY, spectralData });
}

// Run the full experiment. `samples` is the per-spectrum budget (the same budget
// is used for both strategies and all spectra, so the comparison is at equal
// sample count). `screenBins` is the coarse dispersion-frame resolution used for
// the per-pixel error and omission metrics.
export function runExperiment({
  spectralData,
  samples = 256,
  seed = 1234,
  seeds = [11, 22, 33, 44, 55],
  screenBins = 192,
  tolerances = DEFAULT_TOLERANCES,
  filterSpec = { kind: 'clear' },
} = {}) {
  const geometry = experimentGeometry(spectralData);
  const filter = buildFilter(filterSpec);

  const analyzed = SPECTRUM_FAMILY.map((entry) => {
    const source = buildFamilySource(entry, spectralData);
    return analyzeSpectrum({
      id: entry.id,
      label: entry.label,
      source,
      spectralData,
      geometry,
      filter,
      samples,
      seeds,
      screenBins,
    });
  });
  const byId = new Map(analyzed.map((s) => [s.id, s]));

  const calibration = CALIBRATION_IDS.map((id) => byId.get(id));
  const blind = BLIND_IDS.map((id) => byId.get(id));
  const rule = calibrateRule(calibration, { tolerances });
  const blindEvaluation = evaluateRule(rule, blind, { tolerances });

  return {
    config: {
      samples, seed, seeds: [...seeds], screenBins, tolerances, filterSpec,
      geometry: { ...EXPERIMENT_GEOMETRY },
      view: { ...VIEW },
      strategies: { ...STRATEGY_LABELS },
      calibrationIds: [...CALIBRATION_IDS],
      blindIds: [...BLIND_IDS],
    },
    spectra: analyzed,
    calibration,
    blind,
    rule,
    blindEvaluation,
  };
}

// Calibrate cStar at an arbitrary budget from the in-repo calibration family only.
// The live window uses this: the threshold is a function of the sample budget, so
// rather than hard-coding one number it recomputes it on the calibration spectra
// at the budget the user is about to compare at. The blind half is never touched
// here. Returns the rule plus the calibration points so the UI can show its basis.
export function calibrateAtBudget({
  spectralData,
  samples = 256,
  seeds = [11, 22, 33],
  screenBins = 192,
  tolerances = DEFAULT_TOLERANCES,
  filterSpec = { kind: 'clear' },
} = {}) {
  const geometry = experimentGeometry(spectralData);
  const filter = buildFilter(filterSpec);
  const calibration = CALIBRATION_IDS.map((id) => {
    const entry = SPECTRUM_FAMILY.find((e) => e.id === id);
    const source = buildFamilySource(entry, spectralData);
    return analyzeSpectrum({ id, label: entry.label, source, spectralData, geometry, filter, samples, seeds, screenBins });
  });
  return calibrateRule(calibration, { tolerances });
}

// Compact serialisable form for the CLI, the UI badge and the tests. Keeps every
// number that the decision or the report depends on; drops the heavy per-sample
// rows so it can be committed and diffed.
export function experimentEvidence(result) {
  const num = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : null);
  const pick = (m) => ({
    globalDeltaE: num(m.globalDeltaE),
    pixelDeltaE: num(m.pixelDeltaE),
    compositeDeltaE: num(m.compositeDeltaE),
    omission: num(m.omission),
    darkBins: m.darkBins,
    litBins: m.litBins,
    binCoverage: num(m.binCoverage),
    bandCoverage: num(m.bandCoverage),
    unresolved: m.unresolved,
  });
  return {
    config: {
      samples: result.config.samples,
      seed: result.config.seed,
      seeds: result.config.seeds,
      screenBins: result.config.screenBins,
      tolerances: result.config.tolerances,
      geometry: result.config.geometry,
      calibrationIds: result.config.calibrationIds,
      blindIds: result.config.blindIds,
    },
    spectra: result.spectra.map((s) => ({
      id: s.id,
      label: s.label,
      widthNm: num(s.width),
      concentration: num(s.concentration),
      fixed: { ...pick(s.runs.fixed.metrics), rays: s.runs.fixed.rays, proposalRays: s.runs.fixed.proposalRays },
      joint: { ...pick(s.runs.joint.metrics), rays: s.runs.joint.rays, proposalRays: s.runs.joint.proposalRays },
    })),
    rule: {
      cStar: num(result.rule.cStar),
      calibrationErrors: result.rule.errors,
      calibrationTotalRays: result.rule.totalRays,
      points: result.rule.points.map((p) => ({
        id: p.id,
        concentration: num(p.concentration),
        target: p.target,
        fixedSufficient: p.fixedSufficient,
        jointSufficient: p.jointSufficient,
      })),
    },
    blind: {
      summary: {
        ...result.blindEvaluation.summary,
        meanFixedCompositeDeltaE: num(result.blindEvaluation.summary.meanFixedCompositeDeltaE),
        meanJointCompositeDeltaE: num(result.blindEvaluation.summary.meanJointCompositeDeltaE),
        meanFixedColourDeltaE: num(result.blindEvaluation.summary.meanFixedColourDeltaE),
        meanJointColourDeltaE: num(result.blindEvaluation.summary.meanJointColourDeltaE),
        meanFixedOmission: num(result.blindEvaluation.summary.meanFixedOmission),
        meanJointOmission: num(result.blindEvaluation.summary.meanJointOmission),
        chosenRayRatioVsJoint: num(result.blindEvaluation.summary.chosenRayRatioVsJoint),
      },
      rows: result.blindEvaluation.rows.map((r) => ({
        id: r.id,
        concentration: num(r.concentration),
        decision: r.decision,
        agree: r.agree,
        chosenSufficient: r.chosenSufficient,
        fixed: pick(r.fixed),
        joint: pick(r.joint),
        chosenRays: r.chosenRays,
      })),
    },
  };
}
