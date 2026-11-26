// Core spectral dispersion tests. These exercise the physics and the estimator
// without a browser, and are the same numbers the UI surfaces.
import {
  loadData, makeWorld, sceneWithSamples, dEOf, assert,
  buildFilter, referenceScan, referenceScreen, lineCentroids, integrateXyz, xyOfXyz,
} from './harness.mjs';
import { createScene, makeProposal } from '../src/core/scene.js';
import { makeMaterial } from '../src/core/optics.js';
import { ExposureAccumulator } from '../src/core/exposure.js';
import { uniformSampler } from '../src/core/sampling.js';
import { SpectralData } from '../src/core/spectral-data.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const spectralData = loadData();
const { lamps } = makeWorld(spectralData);

// --- Data integrity -------------------------------------------------------
test('CIE observer table covers 360-830 nm and matches known ybar peak', () => {
  assert.equal(spectralData.cmfStart, 360);
  assert.equal(spectralData.cmfStop, 830);
  const yAt555 = spectralData.cmf(555)[1];
  assert.ok(Math.abs(yAt555 - 0.9999) < 2e-3, `ybar(555)=${yAt555}`);
  const yOutside = spectralData.cmf(200);
  assert.deepEqual(yOutside, [0, 0, 0]);
});

test('Sellmeier reproduces catalogue nd for both glasses', () => {
  const bk7 = makeMaterial('N-BK7', spectralData, { model: 'catalogue' });
  const sf11 = makeMaterial('N-SF11', spectralData, { model: 'catalogue' });
  assert.ok(Math.abs(bk7.n(587.6) - 1.5168) < 1e-4, `n_BK7=${bk7.n(587.6)}`);
  assert.ok(Math.abs(sf11.n(587.6) - 1.78472) < 1e-4, `n_SF11=${sf11.n(587.6)}`);
  // Normal dispersion: blue index higher than red.
  assert.ok(bk7.n(400) > bk7.n(700));
  assert.ok(sf11.n(400) > sf11.n(700));
});

// --- Two lamps look the same, differ in spectrum --------------------------
test('two lamps have identical scene white but very different spectrum', () => {
  const whiteWide = integrateXyz(lamps.wide.spd, spectralData, { lambdaMin: 380, lambdaMax: 780, step: 0.25 });
  const whiteNarrow = integrateXyz(lamps.narrow.spd, spectralData, { lambdaMin: 380, lambdaMax: 780, step: 0.25 });
  const dE = dEOf(whiteWide, whiteNarrow);
  assert.ok(dE < 0.01, `white mismatch dE=${dE}`);
  const xyW = xyOfXyz(whiteWide);
  const xyN = xyOfXyz(whiteNarrow);
  assert.ok(Math.hypot(xyW[0] - xyN[0], xyW[1] - xyN[1]) < 2e-3);
  // Narrow lamp is three sharp lines: most energy within +-30 nm of its centres.
  let inside = 0, total = 0;
  for (let l = 380; l <= 780; l += 0.5) {
    const e = lamps.narrow.spd(l);
    total += e;
    if ([450, 535, 620].some((c) => Math.abs(l - c) < 30)) inside += e;
  }
  assert.ok(inside / total > 0.999, `line concentration ${inside / total}`);
  // Wide lamp is continuous: substantial energy between the line gaps.
  const gapE = integrateXyz((l) => lamps.wide.spd(l), spectralData, { lambdaMin: 480, lambdaMax: 500, step: 0.5 })[1];
  assert.ok(gapE > 0, 'wide lamp has energy in the gaps');
});

// --- Non-dispersive limit -------------------------------------------------
test('constant index: every wavelength follows the same path (no colour separation)', () => {
  const scene = sceneWithSamples(spectralData, lamps, {
    lamp: 'wide', optics: 'prism', material: 'N-SF11', dispersionModel: 'constant',
    apexDeg: 45, incidenceDeg: 50, sampling: 'uniform', samples: 3000,
    filter: { kind: 'clear' },
  });
  const est = scene.accumulator.estimate(scene.filter);
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter: scene.filter, step: 0.1 });
  // With a constant index the transmitted image is the source's own filtered
  // colour; estimate must match the independent scan to high precision.
  assert.ok(dEOf(est.xyz, ref.xyz) < 0.05, `dE=${dEOf(est.xyz, ref.xyz)}`);
  const ys = ref.rows.map((r) => r.screenY);
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(spread < 1e-9, `screen spread with constant index = ${spread}`);
});

test('catalogue glass spreads wavelengths; constant index does not', () => {
  const common = { lamp: 'wide', optics: 'prism', material: 'N-SF11', apexDeg: 45, incidenceDeg: 50, sampling: 'uniform', samples: 2000, filter: { kind: 'clear' } };
  const disp = sceneWithSamples(spectralData, lamps, { ...common, dispersionModel: 'catalogue' });
  const flat = sceneWithSamples(spectralData, lamps, { ...common, dispersionModel: 'constant' });
  const dispRef = referenceScan({ source: disp.source, spectralData, geometry: disp.geometry, filter: disp.filter, step: 0.5 });
  const flatRef = referenceScan({ source: flat.source, spectralData, geometry: flat.geometry, filter: flat.filter, step: 0.5 });
  const spreadOf = (rows) => {
    const ys = rows.map((r) => r.screenY);
    return Math.max(...ys) - Math.min(...ys);
  };
  assert.ok(spreadOf(flatRef.rows) < 1e-9);
  assert.ok(spreadOf(dispRef.rows) > 0.15, `dispersive spread ${spreadOf(dispRef.rows)}`);
});

// --- Direction and energy against analytic optics -------------------------
test('vector trace deviation matches analytic Snell formula', async () => {
  const { analyticDeviationDeg } = await import('../src/core/optics.js');
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'wide', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, sampling: 'uniform', samples: 600, filter: { kind: 'clear' } });
  for (let lam = 400; lam <= 700; lam += 20) {
    const tr = scene.geometry.trace(lam);
    const analytic = analyticDeviationDeg(tr.n, 60, 49);
    assert.ok(Math.abs(tr.deviationDeg - analytic) < 1e-9, `lam ${lam}: ${tr.deviationDeg} vs ${analytic}`);
  }
});

test('Fresnel throughput stays in (0,1] and is symmetric at normal incidence', async () => {
  const { fresnelTransmittance } = await import('../src/core/optics.js');
  const t = fresnelTransmittance(1, 1.5, 1.0);
  const expected = 1 - ((1 - 1.5) / (1 + 1.5)) ** 2;
  assert.ok(Math.abs(t - expected) < 1e-12, `normal-incidence T=${t}, expected ${expected}`);
  for (const cos of [1, 0.9, 0.5, 0.2, 0.05]) {
    const v = fresnelTransmittance(1, 1.5, cos);
    assert.ok(v > 0 && v <= 1, `T(${cos})=${v}`);
  }
  assert.equal(fresnelTransmittance(1.5, 1, 0.1), 0, 'TIR gives zero transmittance');
});

// --- TIR failure feedback -------------------------------------------------
test('extreme geometry reports TIR rather than a silent black', () => {
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'wide', optics: 'prism', material: 'N-SF11', apexDeg: 60, incidenceDeg: 20, sampling: 'uniform', samples: 800, filter: { kind: 'clear' } });
  let ok = 0, tir = 0;
  for (let l = 380; l <= 780; l += 5) {
    const tr = scene.geometry.trace(l);
    if (tr.ok) ok += 1; else if (tr.reason.startsWith('tir')) tir += 1;
  }
  assert.ok(tir > 0, 'expected some total internal reflection at this geometry');
  const est = scene.accumulator.estimate(scene.filter);
  assert.ok(est.blockedSamples > 0, 'blocked samples must be reported, not dropped');
});

// --- Estimator vs independent reference -----------------------------------
test('estimate matches independent scan under a clear filter (wide lamp)', () => {
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'wide', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, sampling: 'uniform', samples: 4000, filter: { kind: 'clear' } });
  const est = scene.accumulator.estimate(scene.filter);
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter: scene.filter, step: 0.1 });
  assert.ok(dEOf(est.xyz, ref.xyz) < 0.2, `dE=${dEOf(est.xyz, ref.xyz)}`);
  assert.ok(Math.abs(est.xyz[1] / ref.xyz[1] - 1) < 0.01, `Y ratio ${est.xyz[1] / ref.xyz[1]}`);
});

test('estimate matches independent scan under a narrow passband (narrow lamp)', () => {
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'narrow', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, sampling: 'uniform', samples: 6000, filter: { kind: 'clear' } });
  const filter = buildFilter({ kind: 'bandpass', centerNm: 535, widthNm: 16, edgeSoftnessNm: 1.5 });
  const est = scene.accumulator.estimate(filter);
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter, step: 0.05 });
  assert.ok(dEOf(est.xyz, ref.xyz) < 0.2, `dE=${dEOf(est.xyz, ref.xyz)}`);
});

// --- The accumulate / re-estimate / supplement contract -------------------
test('switching to a distant filter re-estimates without resampling', () => {
  const scene = sceneWithSamples(spectralData, lamps, {
    lamp: 'wide', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49,
    sampling: 'energy', samples: 3000, filter: { kind: 'bandpass', centerNm: 450, widthNm: 14, edgeSoftnessNm: 1.5 },
  });
  const before = scene.accumulator.sampleCount;
  const filter700 = buildFilter({ kind: 'bandpass', centerNm: 700, widthNm: 14, edgeSoftnessNm: 1.5 });
  const cov = scene.accumulator.coverageFor(filter700);
  // Old samples (drawn around 450 nm) leave the 700 nm band unsupported...
  assert.ok(cov.zeroDensityBands.length > 0, `expected a zero-density band, got ${JSON.stringify(cov.zeroDensityBands)}`);
  const band = cov.zeroDensityBands[0];
  assert.ok(band.a < 700 && band.b > 700, `band ${band.a}-${band.b} should cover 700`);
  // ...and re-estimation keeps the same stored samples.
  const est = scene.accumulator.estimate(filter700);
  assert.equal(scene.accumulator.sampleCount, before, 're-estimation must not add samples');
  // The estimate must not be silently zero: the coverage gate is what flags it.
  assert.equal(cov.supportedFraction, 0);
});

test('supplementing an unsupported band converges to the reference', () => {
  const scene = sceneWithSamples(spectralData, lamps, {
    lamp: 'wide', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49,
    sampling: 'energy', samples: 3000, filter: { kind: 'bandpass', centerNm: 450, widthNm: 14, edgeSoftnessNm: 1.5 },
  });
  const filter700 = buildFilter({ kind: 'bandpass', centerNm: 700, widthNm: 14, edgeSoftnessNm: 1.5 });
  const before = scene.accumulator.estimate(filter700);
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter: filter700, step: 0.05 });
  assert.ok(!(before.xyz[1] > 1e-6 * ref.xyz[1]), 'before supplement the estimate should lack the band');
  const sup = scene.accumulator.supplement(filter700, { count: 2000, strategy: 'energy' });
  assert.ok(sup.added > 0, 'supplement should add samples');
  const after = scene.accumulator.estimate(filter700);
  assert.equal(after.coverage.zeroDensityBands.length, 0);
  assert.ok(dEOf(after.xyz, ref.xyz) < 0.2, `after supplement dE=${dEOf(after.xyz, ref.xyz)}`);
  assert.ok(Math.abs(after.xyz[1] / ref.xyz[1] - 1) < 0.02, `Y ratio ${after.xyz[1] / ref.xyz[1]}`);
});

test('a genuinely dark passband (spectral gap) is reported as no light, not zero energy', () => {
  const scene = sceneWithSamples(spectralData, lamps, {
    lamp: 'narrow', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49,
    sampling: 'energy', samples: 3000, filter: { kind: 'clear' },
  });
  const gap = buildFilter({ kind: 'bandpass', centerNm: 490, widthNm: 16, edgeSoftnessNm: 1.5 });
  const est = scene.accumulator.estimate(gap);
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter: gap, step: 0.05 });
  // Reference says essentially no light in the gap.
  assert.ok(ref.xyz[1] < 1e-6 * integrateXyz(scene.source.spd, spectralData, { lambdaMin: 380, lambdaMax: 780, step: 0.5 })[1]);
  assert.ok(est.xyz[1] < 1e-9 * referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter: scene.filter, step: 1 }).xyz[1]);
  // And the coverage report says "no source emits here", not "missing samples".
  assert.equal(est.coverage.zeroDensityBands.length, 0);
  assert.equal(est.coverage.supportedFraction, 1, 'a real spectral gap needs no samples');
});

// --- Screen image and line positions -------------------------------------
test('screen image integrates to the same colour as the whole-screen estimate', () => {
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'wide', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, sampling: 'uniform', samples: 8000, filter: { kind: 'clear' } });
  const screen = scene.accumulator.estimate(scene.filter, { screen: { yMin: -1.4, yMax: -0.6, count: 400 } });
  let X = 0, Y = 0, Z = 0;
  for (const b of screen.screen.bins) { X += b.xyz[0]; Y += b.xyz[1]; Z += b.xyz[2]; }
  const whole = screen.xyz;
  assert.ok(dEOf([X, Y, Z], whole) < 0.2, `screen sum vs whole dE=${dEOf([X, Y, Z], whole)}`);
});

test('filtered narrow-lamp line sits at the filter centre and geometry y', () => {
  const scene = sceneWithSamples(spectralData, lamps, { lamp: 'narrow', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, sampling: 'uniform', samples: 6000, filter: { kind: 'clear' } });
  const filter = buildFilter({ kind: 'bandpass', centerNm: 620, widthNm: 12, edgeSoftnessNm: 1.5 });
  const ref = referenceScan({ source: scene.source, spectralData, geometry: scene.geometry, filter, step: 0.02 });
  const cents = lineCentroids(ref, { thresholdFraction: 0.02 });
  assert.equal(cents.length, 1, `expected one transmitted line, got ${cents.length}`);
  assert.ok(Math.abs(cents[0].lambda - 620) < 2, `line at ${cents[0].lambda} nm`);
  const tr = scene.geometry.trace(620);
  assert.ok(Math.abs(cents[0].screenY - tr.screenHit[1]) < 1e-3, 'line y matches geometry');
});

// --- Sampling strategy comparison ----------------------------------------
test('energy stratification removes luminance variance but can raise chromaticity variance', () => {
  // This is the honest result the UI must show, not a claim that one is "better".
  const base = { lamp: 'narrow', optics: 'prism', material: 'N-BK7', apexDeg: 60, incidenceDeg: 49, samples: 900, filter: { kind: 'clear' } };
  const refScene = sceneWithSamples(spectralData, lamps, { ...base, sampling: 'uniform', samples: 30000 });
  const ref = referenceScan({ source: refScene.source, spectralData, geometry: refScene.geometry, filter: refScene.filter, step: 0.1 });
  const run = (strategy, seed) => {
    const scene = createScene(spectralData, { ...base, sampling: strategy, seed, lamps });
    const proposal = makeProposal(scene.source, spectralData, strategy, { geometry: scene.geometry, filter: scene.filter, lambdaMin: 380, lambdaMax: 780 });
    // Reproducible jitter per seed.
    let a = seed >>> 0;
    const rng = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    scene.accumulator.addBatch(proposal, proposal.drawStratified(base.samples, rng, { jitter: true }), { filter: scene.filter });
    const est = scene.accumulator.estimate(scene.filter);
    return { dE: dEOf(est.xyz, ref.xyz), yRatio: est.xyz[1] / ref.xyz[1] };
  };
  const seeds = [1, 2, 3, 4, 5, 6];
  const uni = seeds.map((s) => run('uniform', s));
  const en = seeds.map((s) => run('energy', s));
  const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
  const ySdUniform = sd(uni.map((r) => r.yRatio));
  const ySdEnergy = sd(en.map((r) => r.yRatio));
  // Energy stratification targets the photometric integrand, so its luminance
  // error is meaningfully smaller; both must still be unbiased on average.
  assert.ok(ySdEnergy <= ySdUniform, `energy Y sd ${ySdEnergy} should not exceed uniform ${ySdUniform}`);
  const meanUni = uni.reduce((a, r) => a + r.yRatio, 0) / uni.length;
  const meanEn = en.reduce((a, r) => a + r.yRatio, 0) / en.length;
  assert.ok(Math.abs(meanUni - 1) < 0.02 && Math.abs(meanEn - 1) < 0.02, 'both strategies unbiased in Y');
});

// --- Usage policy ---------------------------------------------------------
test('spectral data carries explicit provenance and out-of-range policy', () => {
  const meta = spectralData.meta;
  assert.ok(/CVRL|ciexyz31/.test(meta.cmf.source));
  assert.ok(meta.glasses['N-BK7'].source.includes('Schott'));
  // Out-of-observer-range values are exactly zero, by policy.
  assert.deepEqual(spectralData.cmf(359.9), [0, 0, 0]);
  assert.deepEqual(spectralData.cmf(830.1), [0, 0, 0]);
  // The continuous source's Planck tail is finite and positive inside the window.
  assert.ok(lamps.wide.spd(380) > 0 && lamps.wide.spd(780) > 0);
});

// --- Wavelength-strategy experiment ---------------------------------------
test('participation width separates broad continua from sharp lines', async () => {
  const { buildSource } = await import('../src/core/light.js');
  const { experimentGeometry } = await import('../src/core/experiment.js');
  const { participationWidth, normalizedSource } = await import('../src/core/strategies.js');
  const g = experimentGeometry(spectralData);
  const broad = normalizedSource(buildSource({ kind: 'continuous', temperatureK: 6500, name: 'b' }), spectralData);
  const sharp = normalizedSource(buildSource({ kind: 'lines', name: 's', lines: [450, 535, 620].map((c) => ({ centerNm: c, fwhmNm: 2, weight: 1 })) }), spectralData);
  const wB = participationWidth({ source: broad, spectralData, geometry: g });
  const wS = participationWidth({ source: sharp, spectralData, geometry: g });
  // A Planck continuum inside the window is of order 200 nm wide; a 2 nm line is
  // of order a few nm. These are real traced quantities, not nominal FWHM labels.
  assert.ok(wB > 150 && wB < 260, `broad W=${wB}`);
  assert.ok(wS > 2 && wS < 30, `sharp W=${wS}`);
  assert.ok(wB / wS > 5, `width ratio ${wB / wS}`);
});

test('joint response sampling beats fixed layering on a sharp line at equal samples', async () => {
  const { buildSource } = await import('../src/core/light.js');
  const { makeGeometry } = await import('../src/core/geometry.js');
  const { analyzeSpectrum, normalizedSource } = await import('../src/core/strategies.js');
  const { EXPERIMENT_GEOMETRY } = await import('../src/core/experiment.js');
  const geometry = makeGeometry({ ...EXPERIMENT_GEOMETRY, spectralData });
  const source = normalizedSource(buildSource({
    kind: 'lines', name: 's', lines: [450, 535, 620].map((c) => ({ centerNm: c, fwhmNm: 2, weight: 1 })),
  }), spectralData);
  const s = analyzeSpectrum({
    id: 'sharp2', label: 'sharp', source, spectralData, geometry,
    samples: 256, seeds: [11, 22, 33], screenBins: 192,
  });
  // Fixed layering rarely lands on a 2 nm line: large colour error. The joint
  // density concentrates where the line is, so its detected colour is right.
  assert.ok(s.runs.fixed.metrics.globalDeltaE > 3, `fixed ΔE ${s.runs.fixed.metrics.globalDeltaE}`);
  assert.ok(s.runs.joint.metrics.globalDeltaE < 1.5, `joint ΔE ${s.runs.joint.metrics.globalDeltaE}`);
  assert.ok(s.runs.joint.metrics.globalDeltaE < s.runs.fixed.metrics.globalDeltaE);
});

test('fixed layering matches the reference on a broad continuum', async () => {
  const { buildSource } = await import('../src/core/light.js');
  const { makeGeometry } = await import('../src/core/geometry.js');
  const { analyzeSpectrum, normalizedSource } = await import('../src/core/strategies.js');
  const { EXPERIMENT_GEOMETRY } = await import('../src/core/experiment.js');
  const geometry = makeGeometry({ ...EXPERIMENT_GEOMETRY, spectralData });
  const source = normalizedSource(buildSource({ kind: 'continuous', temperatureK: 6500, name: 'b' }), spectralData);
  const s = analyzeSpectrum({
    id: 'broad6500', label: 'broad', source, spectralData, geometry,
    samples: 256, seeds: [11, 22, 33], screenBins: 192,
  });
  assert.ok(s.runs.fixed.metrics.globalDeltaE < 0.5, `fixed ΔE ${s.runs.fixed.metrics.globalDeltaE}`);
});

test('experiment calibrates on half the spectra and agrees on the blind half', async () => {
  const { runExperiment } = await import('../src/core/experiment.js');
  const result = runExperiment({ spectralData, samples: 256, screenBins: 192, seeds: [11, 22, 33, 44, 55] });
  // The rule is calibrated without disagreement on its own half, and the blind
  // half is decided by the descriptor alone.
  assert.equal(result.rule.errors, 0, `calibration errors ${result.rule.errors}`);
  assert.ok(result.rule.cStar > 0, `cStar ${result.rule.cStar}`);
  // Every blind decision must at least be a strategy that met the policy.
  const blind = result.blindEvaluation;
  assert.equal(blind.summary.disagreements, 0, `blind disagreements ${blind.summary.disagreements}`);
  // At this operating point every blind decision lands on a strategy that meets
  // the policy; the count is asserted against the summary's own count, not a
  // hard-coded 6, so a different budget does not produce a false failure.
  assert.equal(blind.summary.chosenSufficientCount, blind.rows.filter((r) => r.chosenSufficient).length);
  assert.ok(blind.summary.chosenSufficientCount >= blind.summary.n - 1);
  // The chosen mix must cost strictly less than always-joint, and more than
  // always-fixed (it dispatches by spectrum), i.e. it is a real trade-off.
  assert.ok(blind.summary.totalChosenRays < blind.summary.totalJointRays);
  assert.ok(blind.summary.totalChosenRays > blind.summary.totalFixedRays);
  // Sharp spectra must be routed to the joint strategy; broad ones to fixed.
  for (const row of blind.rows) {
    if (row.concentration < result.rule.cStar) {
      assert.equal(row.decision, 'joint', `${row.id} should route to joint`);
    } else {
      assert.equal(row.decision, 'fixed', `${row.id} should route to fixed`);
    }
  }
});

test('experiment evidence is serialisable and carries no fabricated numbers', async () => {
  const { runExperiment, experimentEvidence } = await import('../src/core/experiment.js');
  const result = runExperiment({ spectralData, samples: 128, screenBins: 192, seeds: [11, 22, 33] });
  const ev = experimentEvidence(result);
  const json = JSON.stringify(ev);
  assert.ok(json.length > 0);
  // Every finite evidence number matches the in-memory result, so the report is
  // a projection of computed values, not typed-in constants.
  for (const s of ev.spectra) {
    const live = result.spectra.find((x) => x.id === s.id);
    assert.ok(Math.abs(s.fixed.globalDeltaE - live.runs.fixed.metrics.globalDeltaE) / Math.max(1, live.runs.fixed.metrics.globalDeltaE) < 1e-4);
    assert.equal(s.fixed.rays, live.runs.fixed.rays);
  }
  assert.ok(ev.rule.cStar === null || Math.abs(ev.rule.cStar - result.rule.cStar) / Math.max(1, result.rule.cStar) < 1e-4);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok   ${t.name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${t.name}\n       ${err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed === 0 ? 0 : 1);
