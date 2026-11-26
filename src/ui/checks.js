// Verification checks surfaced in the UI. Each check is computed from the core's
// own outputs (estimate, reference scan, geometry) and reports pass/fail/warn with
// the numbers behind it. These are the independent wavelength-scan cross-checks:
// direction, energy, integration convergence, the no-dispersion limit, coverage,
// and filtered line position.

import { deltaE76, xyOfXyz } from '../core/colorimetry.js';
import { analyticDeviationDeg } from '../core/optics.js';
import { lineCentroids, referenceScreen } from '../core/reference.js';
import { makeGeometry } from '../core/geometry.js';
import { buildFilter } from '../core/light.js';
import { createScene, makeProposal } from '../core/scene.js';
import { mulberry32 } from '../core/sampling.js';

function norm(xyz) {
  return xyz[1] > 0 ? [xyz[0] / xyz[1], 1, xyz[2] / xyz[1]] : [0, 0, 0];
}

export function runChecks({ scene, estimate, reference, state, VIEW }) {
  const out = [];
  if (!scene || !estimate || !reference) {
    out.push({ name: 'core ready', status: 'warn', value: 'waiting', detail: 'no estimate yet' });
    return out;
  }
  const { spectralData, geometry } = scene;
  const refDark = !(reference.xyz[1] > 0);

  // 1. Estimate vs independent reference (filtered colour), only where light
  //    reaches the screen. A legitimately dark screen is reported as such, not
  //    as a chromaticity failure. An estimate whose lit bands lack proposal
  //    support is *unresolved* — comparing it would read empty bins as zero
  //    energy, which is exactly the mistake this check exists to catch.
  const cov0 = estimate.coverage;
  const uncovered = !cov0.supported;
  if (refDark) {
    out.push({
      name: 'estimate vs independent scan (ΔE76)',
      status: estimate.xyz[1] > 1e-9 && !uncovered ? 'warn' : 'info',
      value: 'both dark',
      detail: 'no wavelength in the passband reaches the screen; chromaticity is undefined, not zero',
    });
  } else if (uncovered) {
    const bands = [...cov0.zeroDensityBands, ...cov0.insufficientBands]
      .map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}nm`).join(', ');
    out.push({
      name: 'estimate vs independent scan (ΔE76)',
      status: 'warn',
      value: 'unresolved (not zero)',
      detail: `lit band ${bands} has no sample support; the estimate is undefined there, not black — supplement before comparing`,
    });
  } else {
    const dE = deltaE76(norm(estimate.xyz), norm(reference.xyz));
    const lumRatio = estimate.xyz[1] / reference.xyz[1];
    out.push({
      name: 'estimate vs independent scan (ΔE76)',
      status: dE < 1 ? 'pass' : dE < 3 ? 'warn' : 'fail',
      value: `ΔE76 ${dE.toFixed(4)}`,
      detail: `Y est/ref ${lumRatio.toFixed(5)}; reference is a 0.1 nm uniform scan sharing no sampling code`,
    });
  }

  // 2. Direction: vector-trace deviation vs Snell's-law formula per wavelength.
  if (geometry.kind === 'prism') {
    let maxErr = 0;
    let n = 0;
    for (let lam = 400; lam <= 700; lam += 25) {
      const tr = geometry.trace(lam);
      if (!tr.ok) continue;
      const analytic = analyticDeviationDeg(tr.n, state.apex, state.incidence);
      if (analytic === null) continue;
      maxErr = Math.max(maxErr, Math.abs(tr.deviationDeg - analytic));
      n += 1;
    }
    out.push({
      name: 'ray direction vs Snell formula',
      status: n === 0 ? 'warn' : maxErr < 1e-6 ? 'pass' : 'fail',
      value: n === 0 ? 'all rays TIR' : `max |Δ| ${maxErr.toExponential(2)}°`,
      detail: n === 0 ? 'no wavelength transmits this geometry' : `vector trace matches analytic deviation over ${n} wavelengths`,
    });
  } else {
    out.push({
      name: 'ray direction vs Snell formula',
      status: 'info',
      value: 'vacuum path',
      detail: 'straight path, deviation identically 0',
    });
  }

  // 3. Energy bounds: Fresnel throughput in (0,1] throughout the scan.
  let bad = 0;
  let tMin = Infinity;
  for (const row of reference.rows) {
    if (!(row.T > 0) || row.T > 1 + 1e-9) bad += 1;
    tMin = Math.min(tMin, row.T);
  }
  out.push({
    name: 'path energy bounds (Fresnel)',
    status: bad === 0 ? 'pass' : 'fail',
    value: `${bad} out-of-range, min T ${Number.isFinite(tMin) ? tMin.toFixed(4) : '—'}`,
    detail: 'unpolarized transmittance across both faces, zero absorption',
  });

  // 4. Dispersion is in the *paths*, not a post tint. The total stray-light
  //    integral over the whole screen is unchanged by dispersion (it only moves
  //    light around), so we compare the spatial colour distribution instead:
  //    with a constant index every wavelength lands at one spot (white line);
  //    with the catalogue it spreads. A narrow passband also collapses the spread
  //    to one colour, which is a real result, not a failure.
  try {
    const filterForCheck = buildFilter(state.filterKind === 'bandpass'
      ? { kind: 'bandpass', centerNm: state.filterCenter, widthNm: state.filterWidth, edgeSoftnessNm: 1.5 }
      : { kind: 'clear' });
    const constantGeom = makeGeometry({
      optics: state.optics,
      material: state.material,
      spectralData,
      dispersionModel: 'constant',
      apexDeg: state.apex,
      incidenceDeg: state.incidence,
      entryFraction: 0.5,
    });
    const spread = screenSpread(geometry, scene, filterForCheck);
    const constSpread = screenSpread(constantGeom, scene, filterForCheck);
    const isConstant = scene.geometry.material?.model === 'constant';
    out.push({
      name: 'screen spread: dispersive vs constant',
      status: 'info',
      value: `${spread.toFixed(4)} vs ${constSpread.toFixed(4)}`,
      detail: isConstant
        ? 'constant-index model: screen spread is ~0 (all wavelengths share one spot)'
        : spread > constSpread + 1e-4
          ? 'catalogue dispersion spreads the image; constant index keeps it a single spot — colour comes from path differences'
          : 'passband narrow enough that both models land on one spot (expected)',
    });
  } catch (err) {
    out.push({ name: 'screen spread: dispersive vs constant', status: 'warn', value: 'error', detail: String(err.message || err) });
  }

  // 5. Coverage: unsupported bands must be reported, never zero-filled.
  const cov = estimate.coverage;
  out.push({
    name: 'passband coverage',
    status: cov.zeroDensityBands.length ? 'fail' : cov.insufficientBands.length ? 'warn' : 'pass',
    value: `${(cov.supportedFraction * 100).toFixed(1)}% of lit band`,
    detail: cov.zeroDensityBands.length
      ? `zero-density: ${cov.zeroDensityBands.map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}nm`).join(', ')} — supplement before trusting`
      : cov.insufficientBands.length
        ? `under-supported: ${cov.insufficientBands.map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}nm`).join(', ')}`
        : 'every lit, transmitting band has proposal support',
  });

  // 6. Filtered line position for the narrow lamp.
  if (scene.source.kind === 'lines' && state.filterKind === 'bandpass') {
    const cents = lineCentroids(reference, { thresholdFraction: 0.05 });
    if (cents.length === 0) {
      out.push({ name: 'filtered line position', status: 'info', value: 'no line transmitted', detail: `passband ${state.filterCenter}nm misses all emission lines` });
    } else {
      const match = cents.reduce((best, c) =>
        Math.abs(c.lambda - state.filterCenter) < Math.abs(best.lambda - state.filterCenter) ? c : best, cents[0]);
      const trCenter = geometry.trace(state.filterCenter);
      const lambdaErr = Math.abs(match.lambda - state.filterCenter);
      const yErr = trCenter.ok ? Math.abs(match.screenY - trCenter.screenHit[1]) : NaN;
      out.push({
        name: 'filtered line position',
        status: lambdaErr < 3 && yErr < 0.01 ? 'pass' : 'warn',
        value: `${match.lambda.toFixed(1)} nm @ y ${match.screenY.toFixed(3)}`,
        detail: `filter centre ${state.filterCenter} nm; geometry predicts y ${trCenter.ok ? trCenter.screenHit[1].toFixed(3) : 'TIR'}`,
      });
    }
  }

  // 7. Sampling-strategy comparison: uniform vs energy-stratified, same sample
  //    budget, several seeds, each measured against a dense reference. The honest
  //    result is that energy stratification is chosen for luminance/energy but is
  //    not automatically lower-DeltaE — colour variance can go either way.
  if (!refDark) {
    try {
      const diagnostics = samplingStrategyCompare(scene, reference);
      if (diagnostics) {
        const { uniform, energy, budget } = diagnostics;
        out.push({
          name: 'sampling: uniform vs energy-stratified',
          status: 'info',
          value: `ΔE σ ${uniform.dESd.toFixed(3)} vs ${energy.dESd.toFixed(3)}; Y σ ${uniform.ySd.toFixed(4)} vs ${energy.ySd.toFixed(4)}`,
          detail: `same ${budget}-sample budget, 5 seeds. Y σ (luminance stability) ${energy.ySd <= uniform.ySd ? 'lower' : 'higher'} for energy; ΔE σ (colour stability) ${energy.dESd <= uniform.dESd ? 'lower' : 'higher'} — energy sampling targets energy, not chromaticity`,
        });
      }
    } catch (err) {
      out.push({ name: 'sampling: uniform vs energy-stratified', status: 'warn', value: 'error', detail: String(err.message || err) });
    }
  }

  return out;
}

// Width of the illuminated screen band: the 5th-95th percentile span of screen y
// weighted by transmitted photometric energy. Zero for a non-dispersive path;
// grows with dispersion. A percentile span is used rather than a standard
// deviation so a faint far tail (a few wavelengths at the passband edges) does
// not dominate the number.
function screenSpread(geometry, scene, filter) {
  const { source, spectralData } = scene;
  const pts = [];
  const step = 0.5;
  for (let lam = 380; lam <= 780; lam += step) {
    const L = source.spd(lam);
    const f = filter.transmission(lam);
    if (!(L > 0) || !(f > 0)) continue;
    const tr = geometry.trace(lam);
    if (!tr.ok || !(tr.T > 0) || !tr.screenHit) continue;
    const w = L * f * tr.T * spectralData.cmf(lam)[1] * step;
    pts.push([tr.screenHit[1], w]);
  }
  if (pts.length === 0) return 0;
  pts.sort((a, b) => a[0] - b[0]);
  const totalW = pts.reduce((s, p) => s + p[1], 0);
  if (!(totalW > 0)) return 0;
  const quantile = (q) => {
    let acc = 0;
    for (const [y, w] of pts) {
      acc += w;
      if (acc >= q * totalW) return y;
    }
    return pts[pts.length - 1][0];
  };
  return quantile(0.95) - quantile(0.05);
}

// Compare uniform vs energy-stratified proposals at the current scene settings.
// Same sample budget, several seeds; each estimate is scored against the dense
// independent reference. Returns the spread (std dev over seeds) of ΔE76 and of
// the Y ratio, which is the variance the strategy control is supposed to move.
function samplingStrategyCompare(scene, reference) {
  const refXyz = reference.xyz;
  if (!(refXyz[1] > 0)) return null;
  const refN = [refXyz[0] / refXyz[1], 1, refXyz[2] / refXyz[1]];
  const budget = Math.max(80, Math.min(400, Math.round(scene.sampling.samples / 10)));
  const seeds = [1, 2, 3, 4, 5];
  const run = (strategy) => {
    const out = [];
    for (const seed of seeds) {
      const s = createScene(scene.spectralData, {
        ...scene.params,
        lamps: scene.lamps,
        sampling: strategy,
        samples: budget,
        seed,
      });
      const proposal = makeProposal(s.source, scene.spectralData, strategy, {
        geometry: s.geometry,
        filter: s.filter,
        lambdaMin: 380,
        lambdaMax: 780,
      });
      const rng = mulberry32(seed);
      s.accumulator.addBatch(proposal, proposal.drawStratified(budget, rng, { jitter: true }), { filter: s.filter });
      const est = s.accumulator.estimate(s.filter);
      const n = est.xyz[1] > 0 ? [est.xyz[0] / est.xyz[1], 1, est.xyz[2] / est.xyz[1]] : [0, 0, 0];
      out.push({ dE: est.xyz[1] > 0 ? deltaE76(n, refN) : Infinity, y: est.xyz[1] / refXyz[1] });
    }
    return out;
  };
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const summarize = (rows) => ({ dESd: sd(rows.map((r) => r.dE)), ySd: sd(rows.map((r) => r.y)) });
  return { budget, uniform: summarize(run('uniform')), energy: summarize(run('energy')) };
}
