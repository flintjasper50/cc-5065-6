// UI controller. Owns the parameter state, drives the spectral core, renders the
// scene, screen image, spectrum plot, contribution table and the verification
// panel. Every numeric readout shown here is taken from the core's own returned
// structures; nothing is re-derived in the UI.

import { loadSpectralData, buildLamps, createScene, makeProposal, VIEW } from '../core/scene.js';
import { buildFilter } from '../core/light.js';
import { referenceScan, referenceScreen, lineCentroids } from '../core/reference.js';
import { deltaE76, xyOfXyz, wavelengthLabelRgb } from '../core/colorimetry.js';
import { drawSceneBase, drawSamplePaths, renderScreen, viewToCanvas, fitView } from '../render.js';
import { drawSourcePlot, clearCanvas } from '../ui/plots.js';
import { runChecks } from '../ui/checks.js';
import { runStrategy } from '../core/strategies.js';
import { calibrateAtBudget } from '../core/experiment.js';
import { drawDispersionFrame, drawContributionChart, displayForReference, frameAnomalies } from '../ui/strategy-panel.js';

const THEME = {
  screen: '#05070b',
  screenLabel: '#6b7a90',
  prismFill: 'rgba(150, 190, 255, 0.10)',
  prismStroke: 'rgba(150, 195, 255, 0.55)',
  slabFill: 'rgba(150, 255, 210, 0.08)',
  slabStroke: 'rgba(140, 255, 200, 0.45)',
  sourceMarker: '#ffd479',
  background: '#05070b',
  unresolved: 'rgba(255, 107, 122, 0.16)',
  unresolvedStripe: 'rgba(255, 107, 122, 0.5)',
};

const state = {
  lamp: 'wide',
  filterKind: 'clear',
  filterCenter: 450,
  filterWidth: 14,
  material: 'N-SF11',
  dispersion: 'catalogue',
  apex: 55,
  incidence: 50,
  optics: 'prism',
  sampling: 'uniform',
  samples: 5000,
  tableScope: 'estimate',
  strategyBudget: 500,
  strategyAuto: false,
};

let core = null; // { spectralData, lamps }
let scene = null;
let lastEstimate = null;
let lastReference = null;
let lastError = null;
let stale = false;
let strategyComparison = null; // { runs, rule, reference, anomalies, ... }

const el = (id) => document.getElementById(id);

function showFatal(err) {
  const box = el('fatal');
  box.hidden = false;
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = 'Spectral core error';
  const pre = document.createElement('div');
  pre.textContent = `${err?.name ?? 'Error'}: ${err?.message ?? err}\n\nThe renderer will not draw a substitute image. Fix the parameter or report this to the core owner.`;
  box.append(h, pre);
}

function clearFatal() {
  el('fatal').hidden = true;
}

async function init() {
  try {
    const spectralData = await loadSpectralData(new URL('../../data/spectra/spectral-data.json', import.meta.url));
    const lamps = buildLamps(spectralData);
    core = { spectralData, lamps };
    bindControls();
    rebuild({ initial: true });
    window.addEventListener('resize', debounce(() => renderAll(), 120));
  } catch (err) {
    console.error(err);
    showFatal(err);
  }
}

function bindControls() {
  el('lamp').addEventListener('change', (e) => { state.lamp = e.target.value; rebuild(); });
  el('filterKind').addEventListener('change', (e) => {
    state.filterKind = e.target.value;
    syncFilterVisibility();
    rebuild();
  });
  rangeControl('filterCenter', 'filterCenterVal', (v) => { state.filterCenter = v; rebuild(); });
  rangeControl('filterWidth', 'filterWidthVal', (v) => { state.filterWidth = v; rebuild(); });
  el('material').addEventListener('change', (e) => { state.material = e.target.value; rebuild(); });
  el('dispersion').addEventListener('change', (e) => { state.dispersion = e.target.value; rebuild(); });
  rangeControl('apex', 'apexVal', (v) => { state.apex = v; rebuild(); });
  rangeControl('incidence', 'incidenceVal', (v) => { state.incidence = v; rebuild(); });
  el('optics').addEventListener('change', (e) => { state.optics = e.target.value; rebuild(); });
  el('sampling').addEventListener('change', (e) => { state.sampling = e.target.value; rebuild(); });
  rangeControl('samples', 'samplesVal', (v) => { state.samples = v; rebuild(); });
  el('resample').addEventListener('click', () => rebuild({ forceResample: true }));
  el('supplement').addEventListener('click', () => supplementBands());
  el('runStrategyCompare').addEventListener('click', () => runStrategyComparison());
  el('strategyAuto').addEventListener('change', (e) => {
    state.strategyAuto = e.target.checked;
    if (state.strategyAuto && strategyComparison) applyAutoSwitch();
  });
  for (const r of document.querySelectorAll('input[name="tableScope"]')) {
    r.addEventListener('change', (e) => {
      state.tableScope = e.target.value;
      renderTable();
    });
  }
  syncFilterVisibility();
}

function rangeControl(inputId, outputId, onCommit) {
  const input = el(inputId);
  const output = el(outputId);
  let timer = null;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    output.textContent = String(v);
    clearTimeout(timer);
    timer = setTimeout(() => onCommit(v), 60);
  });
}

function syncControls() {
  el('lamp').value = state.lamp;
  el('filterKind').value = state.filterKind;
  el('filterCenter').value = String(state.filterCenter);
  el('filterCenterVal').textContent = String(state.filterCenter);
  el('filterWidth').value = String(state.filterWidth);
  el('filterWidthVal').textContent = String(state.filterWidth);
  el('material').value = state.material;
  el('dispersion').value = state.dispersion;
  el('apex').value = String(state.apex);
  el('apexVal').textContent = String(state.apex);
  el('incidence').value = String(state.incidence);
  el('incidenceVal').textContent = String(state.incidence);
  el('optics').value = state.optics;
  el('sampling').value = state.sampling;
  el('samples').value = String(state.samples);
  el('samplesVal').textContent = String(state.samples);
  el('strategyBudget').textContent = String(state.strategyBudget);
  el('strategyAuto').checked = state.strategyAuto;
  syncFilterVisibility();
}

function syncFilterVisibility() {
  const active = state.filterKind === 'bandpass';
  el('filterRow').style.opacity = active ? '1' : '0.45';
  el('filterWidthRow').style.opacity = active ? '1' : '0.45';
  el('filterCenter').disabled = !active;
  el('filterWidth').disabled = !active;
}

function filterSpec() {
  return state.filterKind === 'bandpass'
    ? { kind: 'bandpass', centerNm: state.filterCenter, widthNm: state.filterWidth, edgeSoftnessNm: 1.5 }
    : { kind: 'clear' };
}

// Build a fresh scene and (re)populate the accumulator for the current sampling
// strategy. Geometry changes invalidate stored traces; the scene layer handles
// that via the geometry signature.
function rebuild({ initial = false, forceResample = false } = {}) {
  if (!core) return;
  clearFatal();
  try {
    const { spectralData, lamps } = core;
    const prev = scene;
    const next = createScene(spectralData, {
      lamp: state.lamp,
      filter: filterSpec(),
      optics: state.optics,
      material: state.material,
      dispersionModel: state.dispersion,
      apexDeg: state.apex,
      incidenceDeg: state.incidence,
      entryFraction: 0.5,
      sampling: state.sampling,
      samples: state.samples,
      lamps,
    });

    // Accumulate across filter changes: keep the old samples and re-estimate them
    // under the new filter when source, geometry, sampling strategy and sample
    // count are unchanged. This is the "old samples reweighted under the new
    // filter" path; if the new passband has no support it will be reported and
    // can be supplemented, rather than silently starting over.
    const sameSetup = !forceResample && prev && prev.accumulator &&
      prev.source === next.source &&
      prev.sampling.strategy === next.sampling.strategy &&
      prev.samples === next.samples &&
      prev.geometry.signature === next.geometry.signature;

    if (sameSetup && !initial) {
      next.accumulator = prev.accumulator;
      next.accumulator.setGeometry(next.geometry);
      el('accumHint').classList.remove('err');
      el('accumHint').textContent = 'Re-estimated the stored samples under the new filter (no resampling).';
    } else {
      const proposal = makeProposal(next.source, spectralData, state.sampling, {
        geometry: next.geometry,
        filter: next.filter,
        lambdaMin: 380,
        lambdaMax: 780,
      });
      const drawn = proposal.drawStratified(state.samples, undefined, { jitter: false });
      next.accumulator.addBatch(proposal, drawn, {
        label: `${state.sampling} proposal`,
        filter: next.filter,
      });
      el('accumHint').classList.remove('err');
      el('accumHint').textContent = `Drew ${state.samples} samples from the ${state.sampling} proposal.`;
    }
    scene = next;
    stale = false;
    compute();
    invalidateStrategyComparison('scene changed');
  } catch (err) {
    console.error(err);
    lastError = err;
    showFatal(err);
    markStale('Spectral core rejected the current parameters.');
  }
}

function compute() {
  if (!scene) return;
  try {
    const screen = { yMin: VIEW.yMin, yMax: VIEW.yMax, count: 260 };
    const estimate = scene.accumulator.estimate(scene.filter, { screen });
    // Independent reference scan at a fine uniform step.
    const reference = referenceScan({
      source: scene.source,
      spectralData: scene.spectralData,
      geometry: scene.geometry,
      filter: scene.filter,
      step: 0.1,
    });
    lastEstimate = estimate;
    lastReference = reference;
    lastError = null;
    renderAll();
  } catch (err) {
    console.error(err);
    lastError = err;
    showFatal(err);
  }
}

function supplementBands() {
  if (!scene) return;
  try {
    const result = scene.accumulator.supplement(scene.filter, { count: Math.max(800, state.samples), strategy: state.sampling === 'energy' ? 'energy' : 'uniform' });
    if (result.added === 0) {
      el('accumHint').textContent = 'No unsupported bands: existing samples already cover the active passband.';
    } else {
      el('accumHint').textContent = `Added ${result.added} samples across ${result.bands.length} band(s): ${result.bands.map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}nm`).join(', ')}.`;
    }
    compute();
  } catch (err) {
    console.error(err);
    showFatal(err);
  }
}

function markStale(msg) {
  stale = true;
  el('accumHint').textContent = msg;
  el('accumHint').classList.add('err');
}

// ---------------------------------------------------------------------------
// Wavelength-strategy comparison (live, in this window)
// ---------------------------------------------------------------------------
// The comparison is intentionally not cheap: building the joint density traces
// every grid wavelength, so it runs on explicit request (or auto-switch) rather
// than on every slider move. The run state is shown in the panel so the window
// never silently shows a stale comparison as if it were live.

function setStrategyState(kind, text) {
  const box = el('strategyState');
  box.className = `strategyState ${kind}`;
  box.innerHTML = `<span class="lamp"></span><span>${escapeHtml(text)}</span>`;
}

function invalidateStrategyComparison(reason) {
  if (!strategyComparison) return;
  strategyComparison.stale = true;
  setStrategyState('', `idle — comparison stale (${reason}); re-run to compare the current light`);
  el('strategyVerdict').innerHTML = `<span class="verdictWarn">Comparison is stale: the source, filter, prism or sample budget changed after it was computed. Run it again to see the current dispersion frames.</span>`;
}

function runStrategyComparison() {
  if (!scene) return;
  setStrategyState('running', 'running both proposals on the traced prism…');
  el('strategyVerdict').innerHTML = '';
  // Defer one frame so the running state paints before the (synchronous) work.
  setTimeout(() => {
    try {
      computeStrategyComparison();
    } catch (err) {
      console.error(err);
      setStrategyState('err', `error: ${err?.message ?? err}`);
      el('strategyVerdict').innerHTML = `<span class="verdictErr">${escapeHtml(String(err?.message ?? err))}</span>`;
    }
  }, 30);
}

function computeStrategyComparison() {
  const { spectralData } = core;
  // Use the current scene's own geometry/source/filter so the comparison is about
  // *this* light, not the experiment family. The traced prism is the real one.
  const source = scene.source;
  const filter = scene.filter;
  const geometry = scene.geometry;
  const samples = state.strategyBudget;

  // Shared independence reference at a moderate screen resolution so per-bin
  // coverage and per-pixel colour are meaningful without over-sampling noise.
  const layout = existingStrategyScreen(geometry, filter);
  const reference = referenceScan({ source, spectralData, geometry, filter, step: 0.5 });
  const screen = layout;
  const referenceImage = referenceScreen({
    source, spectralData, geometry, filter, step: 0.5,
    yMin: screen.yMin, yMax: screen.yMax, bins: screen.count,
  });
  const shared = { reference, referenceImage };

  const seeds = [11, 22, 33];
  const aggRuns = {};
  for (const strategy of ['fixed', 'joint']) {
    const perSeed = seeds.map((seed) => runStrategy({
      source, spectralData, geometry, filter, strategy, samples, seed, screen, shared,
    }));
    // Choose a representative run (nearest to mean global ΔE) for drawing.
    const meanG = perSeed.reduce((a, r) => a + r.metrics.globalDeltaE, 0) / perSeed.length;
    let rep = perSeed[0];
    let best = Infinity;
    for (const r of perSeed) {
      const d = Math.abs(r.metrics.globalDeltaE - meanG);
      if (d < best) { best = d; rep = r; }
    }
    const metrics = {
      globalDeltaE: meanG,
      pixelDeltaE: perSeed.reduce((a, r) => a + r.metrics.pixelDeltaE, 0) / perSeed.length,
      compositeDeltaE: perSeed.reduce((a, r) => a + r.metrics.compositeDeltaE, 0) / perSeed.length,
      omission: perSeed.reduce((a, r) => a + r.metrics.omission, 0) / perSeed.length,
      darkBins: perSeed.reduce((a, r) => a + r.metrics.darkBins, 0) / perSeed.length,
      litBins: rep.metrics.litBins,
      bandCoverage: perSeed.reduce((a, r) => a + r.metrics.bandCoverage, 0) / perSeed.length,
      unresolved: perSeed.some((r) => r.metrics.unresolved),
    };
    aggRuns[strategy] = { ...rep, metrics, perSeed };
  }

  // Calibrate the switch threshold at this budget, using the in-repo calibration
  // family only. This is the same rule the CLI experiment reports.
  let rule = null;
  try {
    rule = calibrateAtBudget({ spectralData, samples, seeds, screenBins: screen.count });
  } catch (err) {
    console.error('calibration failed', err);
  }

  // Descriptor of the *current* light: participation width and concentration.
  const width = participationWidthOf(source, geometry);
  const c = samples > 0 ? (samples * width) / (780 - 380) : 0;

  const anomalies = {
    fixed: frameAnomalies(aggRuns.fixed.estimate, referenceImage),
    joint: frameAnomalies(aggRuns.joint.estimate, referenceImage),
  };

  strategyComparison = {
    runs: aggRuns, reference, referenceImage, screen, anomalies,
    rule, width, concentration: c, samples,
    sourceLabel: `${scene.source.name ?? scene.source.kind}`,
    geometryLabel: scene.geometry.describe,
    stale: false,
  };
  renderStrategyComparison();
}

// Screen framing for the comparison. Uses the reference landing range so both
// strategies share the exact same bins (a fair per-bin comparison).
function existingStrategyScreen(geometry, filter) {
  const reference = referenceScan({
    source: scene.source, spectralData: core.spectralData, geometry, filter, step: 0.75,
  });
  const range = reference.screenRange;
  if (!range) return { yMin: VIEW.yMin, yMax: VIEW.yMax, count: 160 };
  const span = range[1] - range[0];
  const pad = Math.max(1e-3, span * 0.15);
  return { yMin: range[0] - pad, yMax: range[1] + pad, count: 160 };
}

function participationWidthOf(source, geometry) {
  const spectralData = core.spectralData;
  let s = 0, s2 = 0;
  const step = 1.0;
  for (let l = 380; l <= 780; l += step) {
    const L = source.spd(l);
    if (!(L > 0)) continue;
    const tr = geometry.trace(l);
    if (!tr.ok || !(tr.T > 0)) continue;
    const cmf = spectralData.cmf(l);
    const response = cmf[0] + cmf[1] + cmf[2];
    if (!(response > 0)) continue;
    const w = L * tr.T * response;
    s += w; s2 += w * w;
  }
  return s > 0 ? (s * s / s2) * step : 0;
}

function renderStrategyComparison() {
  if (!strategyComparison) return;
  const { runs, reference, referenceImage, screen, anomalies, rule, width, concentration, samples } = strategyComparison;

  for (const strategy of ['fixed', 'joint']) {
    const run = runs[strategy];
    const display = displayForReference(reference);
    const label = `${strategy} — ${samples} samples, ${run.rays} rays`;
    el(`${strategy}Label`).textContent = label;
    drawDispersionFrame(el(`${strategy}Frame`), {
      estimate: run.estimate, display, anomalies: anomalies[strategy], label: strategy,
    });
    drawContributionChart(el(`${strategy}Contrib`), {
      run, reference, spectralData: core.spectralData, label: `${strategy} Y(λ) vs reference`,
      anomalies: run.estimate.coverage.unsupported,
    });
    const m = run.metrics;
    const dEcl = m.globalDeltaE < 1 ? 'ok' : m.globalDeltaE < 3 ? 'warn' : 'err';
    const omcl = m.omission <= 0.02 ? 'ok' : m.omission <= 0.1 ? 'warn' : 'err';
    el(`${strategy}Stats`).innerHTML = `
      <dt>colour ΔE76</dt><dd class="${dEcl}">${fmt(m.globalDeltaE)}</dd>
      <dt>per-pixel ΔE (rms)</dt><dd>${fmt(m.pixelDeltaE)}</dd>
      <dt>dark-band omission</dt><dd class="${omcl}">${(m.omission * 100).toFixed(2)}%</dd>
      <dt>empty lit bins</dt><dd class="${m.darkBins > 0 ? 'warn' : ''}">${m.darkBins.toFixed(1)} / ${m.litBins}</dt>
      <dt>ray cost</dt><dd>${run.rays}</dd>
      <dt>proposal rays</dt><dd>${run.proposalRays}</dd>`;
  }

  el('strategyBudget').textContent = String(samples);
  el('strategyCStar').textContent = rule ? fmt(rule.cStar) : '—';

  // Verdict: show the measured comparison and the rule's decision, and mark the
  // anomalies that actually show on the frames/contributions.
  const f = runs.fixed.metrics;
  const j = runs.joint.metrics;
  const decision = rule ? (concentration >= rule.cStar ? 'fixed' : 'joint') : null;
  const fixedCheaper = runs.fixed.rays <= runs.joint.rays;
  const lowerError = f.globalDeltaE <= j.globalDeltaE ? 'fixed' : 'joint';
  const anomalyBits = [];
  const fixedEmpty = f.darkBins > 0.5;
  const jointEmpty = j.darkBins > 0.5;
  if (fixedEmpty) anomalyBits.push(`<span class="verdictErr">fixed leaves ${f.darkBins.toFixed(0)} lit bin(s) empty (dark-band omission ${(f.omission * 100).toFixed(1)}%)</span>`);
  if (jointEmpty) anomalyBits.push(`<span class="verdictWarn">joint leaves ${j.darkBins.toFixed(0)} lit bin(s) empty (omission ${(j.omission * 100).toFixed(1)}%)</span>`);
  const uncoveredF = runs.fixed.estimate.coverage.unsupported;
  const uncoveredJ = runs.joint.estimate.coverage.unsupported;
  if (uncoveredF.length) anomalyBits.push(`<span class="verdictErr">fixed: ${uncoveredF.length} unsupported band(s) marked on its contribution chart</span>`);
  if (uncoveredJ.length) anomalyBits.push(`<span class="verdictWarn">joint: ${uncoveredJ.length} unsupported band(s) marked on its contribution chart</span>`);

  const ruleText = rule
    ? `Calibrated rule (in-repo calibration family at ${samples} samples): fixed when c = N·W/Lw &ge; ${fmt(rule.cStar)}. This light has W = ${fmt(width)} nm, c = ${fmt(concentration, 1)} &rarr; <b>${decision}</b>.`
    : 'Rule unavailable (calibration failed); showing the measured comparison only.';

  el('strategyVerdict').innerHTML = `
    <div>${ruleText}</div>
    <div>Measured: lower colour error &rarr; <b>${lowerError}</b>; cheaper rays &rarr; <b>${fixedCheaper ? 'fixed' : 'joint'}</b>. `
    + `fixed ΔE ${fmt(f.globalDeltaE)} / ${runs.fixed.rays} rays; joint ΔE ${fmt(j.globalDeltaE)} / ${runs.joint.rays} rays.</div>
    ${anomalyBits.length ? `<div>Anomalies: ${anomalyBits.join('; ')}.</div>` : '<div class="verdictOk">No empty lit bins or unsupported bands on either frame at this budget.</div>'}`;

  if (state.strategyAuto) applyAutoSwitch();

  // Expose the comparison for automated checks and the screenshot evidence.
  window.__spectralLabStrategy = {
    samples, rule, width, concentration, decision,
    fixed: { dE: f.globalDeltaE, omission: f.omission, rays: runs.fixed.rays, darkBins: f.darkBins, unsupported: uncoveredF.length },
    joint: { dE: j.globalDeltaE, omission: j.omission, rays: runs.joint.rays, darkBins: j.darkBins, unsupported: uncoveredJ.length },
  };
  setStrategyState('ok', `comparison ready — ${samples} samples/strategy, ${runs.fixed.rays}/${runs.joint.rays} rays, ${rule ? `c* ${fmt(rule.cStar)}` : 'no rule'}`);
}

// Auto-switch: when enabled and a comparison exists, make the live production
// proposal match the rule's decision for this light, so "auto" actually changes
// the rendered scene's sampling, not only the comparison labels.
function applyAutoSwitch() {
  if (!strategyComparison || strategyComparison.stale) return;
  const decision = strategyComparison.decision
    ?? (strategyComparison.concentration >= strategyComparison.rule.cStar ? 'fixed' : 'joint');
  const desired = decision === 'fixed' ? 'uniform' : 'joint';
  if (state.sampling !== desired) {
    state.sampling = desired;
    syncControls();
    rebuild({ forceResample: true });
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  if (!scene || !lastEstimate) return;
  renderSceneCanvas();
  renderObserved();
  renderSpectrum();
  renderStats();
  renderTopStats();
  renderTable();
  renderChecks();
}

const PROBE_WAVELENGTHS = [430, 470, 510, 550, 590, 630, 680];

function renderSceneCanvas() {
  const canvas = el('scene');
  const ctx = canvas.getContext('2d');
  const world = fitView(scene.geometry, PROBE_WAVELENGTHS);
  const view = viewToCanvas(world, canvas, { padding: 0.05, world });
  drawSceneBase(ctx, scene.geometry, view, { theme: THEME });

  // Real per-wavelength paths from the estimate rows (same geometry as the
  // estimator; no decorative rainbow).
  drawSamplePaths(ctx, lastEstimate.rows, view, scene.display, { theme: THEME, maxRows: 900, pathAlpha: 0.045 });

  // Highlight a few wavelengths with the exact traced path. These are the same
  // rays the estimator uses; the label ramp is for the wavelength tag only.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const lam of PROBE_WAVELENGTHS) {
    const tr = scene.geometry.trace(lam);
    if (!tr.ok || !tr.path) continue;
    const rgb = wavelengthLabelRgb(lam, scene.spectralData);
    ctx.strokeStyle = `rgba(${rgb.map((c) => Math.round(c * 255)).join(',')},0.9)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    tr.path.forEach(([x, y], i) => {
      const px = view.x(x);
      const py = view.y(y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  // Wavelength tag axis along the screen.
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = '9px ui-monospace, monospace';
  for (const lam of PROBE_WAVELENGTHS) {
    const tr = scene.geometry.trace(lam);
    if (!tr.ok || !tr.screenHit) continue;
    ctx.fillStyle = '#9fb0c8';
    const px = view.x(world.screenX) + 6;
    const py = view.y(tr.screenHit[1]);
    ctx.beginPath();
    ctx.moveTo(view.x(world.screenX) - 3, py);
    ctx.lineTo(view.x(world.screenX) + 2, py);
    ctx.strokeStyle = 'rgba(200,215,235,0.6)';
    ctx.stroke();
    ctx.fillText(String(lam), px, py + 3);
  }
  ctx.restore();

  // Legend.
  const legend = el('sceneLegend');
  legend.innerHTML = `
    <span><i style="background:#7cc4ff"></i>sampled paths</span>
    <span><i style="background:${scene.geometry.kind === 'prism' ? 'rgba(150,195,255,0.8)' : 'rgba(140,255,200,0.8)'}"></i>${scene.geometry.kind}</span>
    <span><i style="background:#ffd479"></i>source</span>`;
}

function renderObserved() {
  const canvas = el('observed');
  const { display } = scene;
  const screen = lastEstimate.screen;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!screen) {
    clearCanvas(ctx, THEME.background);
    return;
  }

  // Fit the vertical view to the actual landing range of the current optics.
  // The screen is physically larger, but only the illuminated band is meaningful;
  // framing it keeps a 2 nm-wide line visible without lying about its position.
  let hitMin = Infinity;
  let hitMax = -Infinity;
  let anyUnresolved = false;
  for (const row of lastEstimate.rows) {
    if (row.screenY === null) continue;
    hitMin = Math.min(hitMin, row.screenY);
    hitMax = Math.max(hitMax, row.screenY);
  }
  // Lit bands with no sample support land somewhere too. Frame to them so the
  // user sees *where* the missing support is instead of a blank panel that could
  // be misread as "no light here".
  if (screen) {
    for (const bin of screen.bins) {
      if (!bin.unresolved) continue;
      anyUnresolved = true;
      hitMin = Math.min(hitMin, bin.y0);
      hitMax = Math.max(hitMax, bin.y1);
    }
  }
  if (!Number.isFinite(hitMin)) {
    clearCanvas(ctx, THEME.background);
    ctx.fillStyle = '#ff6b7a';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('no light: passband transmits no source energy', 8, 20);
    el('screenRange').textContent = '';
    return;
  }
  const span = Math.max(0.06, hitMax - hitMin);
  const pad = Math.max(0.02, span * 0.35);
  const viewMin = hitMin - pad;
  const viewMax = hitMax + pad;

  let peak = 0;
  for (const bin of screen.bins) peak = Math.max(peak, bin.xyz[1]);
  const gain = peak > 0 ? 1 / peak : 0;
  const rowsPx = 512; // vertical colour resolution
  const bins = screen.bins;
  const y0 = bins[0].y0;
  const y1 = bins[bins.length - 1].y1;
  const binH = (y1 - y0) / bins.length;

  // Background.
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, W, H);

  for (const bin of bins) {
    const binTop = Math.max(bin.y0, viewMin);
    const binBot = Math.min(bin.y1, viewMax);
    if (binBot <= binTop) continue;
    const pyTop = H - ((binTop - viewMin) / (viewMax - viewMin)) * H;
    const pyBot = H - ((binBot - viewMin) / (viewMax - viewMin)) * H;
    const h = Math.max(1, pyTop - pyBot);
    if (bin.unresolved) {
      ctx.fillStyle = THEME.unresolved;
      ctx.fillRect(0, pyBot, W, h);
      ctx.strokeStyle = THEME.unresolvedStripe;
      ctx.lineWidth = 1;
      for (let x = -H; x < W; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, pyBot + h);
        ctx.lineTo(x + h, pyBot);
        ctx.stroke();
      }
      continue;
    }
    if (bin.count === 0) {
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, pyBot, W, h);
      continue;
    }
    const { rgb } = display.toSrgb(bin.xyz.map((v) => v * gain));
    ctx.fillStyle = `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`;
    ctx.fillRect(0, pyBot, W, h);
  }

  // y-axis ticks for the illuminated band.
  ctx.fillStyle = '#6b7a90';
  ctx.font = '10px ui-monospace, monospace';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const yv = viewMin + ((viewMax - viewMin) * i) / ticks;
    const py = H - (i / ticks) * H;
    ctx.fillRect(0, py, 5, 1);
    ctx.fillText(yv.toFixed(3), 7, Math.min(H - 2, Math.max(10, py + 3)));
  }
  el('screenRange').textContent = `y ${viewMin.toFixed(3)}…${viewMax.toFixed(3)}`;

  if (anyUnresolved) {
    ctx.fillStyle = '#ff6b7a';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('unresolved band: no sample here', 10, 18);
    ctx.fillText('supplement to read colour', 10, 33);
  }

  window.__spectralLabScreen = { viewMin, viewMax, hitMin, hitMax };
}

function renderSpectrum() {
  const canvas = el('spectrum');
  const ctx = canvas.getContext('2d');
  const samples = lastEstimate ? lastEstimate.rows.map((r) => ({ lambda: r.lambda })) : [];
  drawSourcePlot(ctx, canvas, {
    source: scene.source,
    spectralData: scene.spectralData,
    filter: scene.filter,
    samples,
    lambdaMin: 380,
    lambdaMax: 780,
  });
}

function renderTopStats() {  const { display, sceneWhite } = scene;
  const ref = lastReference;
  const xy = xyOfXyz(ref.xyz);
  const lum = ref.xyz[1];
  el('topstats').innerHTML = `
    <span>result xy <b>${xy[0].toFixed(4)}, ${xy[1].toFixed(4)}</b></span>
    <span>samples <b>${scene.accumulator.sampleCount}</b></span>
    <span>coverage <b>${(lastEstimate.coverage.supportedFraction * 100).toFixed(1)}%</b></span>`;
}

function fmtSci(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e-2 && a < 1e4) return v.toFixed(4);
  return v.toExponential(2);
}

function renderStats() {
  const est = lastEstimate;
  const ref = lastReference;
  const refDark = !(ref.xyz[1] > 0);
  const cov = est.coverage;
  // The estimate is only meaningful where its samples cover the lit passband.
  // When lit, transmitting bands have no proposal support the stored estimate is
  // *unresolved*, not black: an empty bin says "not sampled here", never "zero
  // energy here". Reporting ΔE against the independent scan in that state would
  // read the empty bins as zero, so colour is withheld until the band is filled.
  const uncovered = !cov.supported;
  const estN = norm(est.xyz);
  const refN = norm(ref.xyz);
  const dE = refDark || uncovered ? null : deltaE76(estN, refN);
  const lumRatio = ref.xyz[1] > 0 && !uncovered ? est.xyz[1] / ref.xyz[1] : NaN;
  const xy = xyOfXyz(ref.xyz);

  const swatch = el('screenSwatch');
  const target = averageScreenXyz(est);
  const disp = scene.display.toSrgb(target.map((v) => v * (target[1] > 0 ? 1 : 0)));
  swatch.style.background = `rgb(${disp.rgb.map((c) => Math.round(c * 255)).join(',')})`;
  if (uncovered) {
    swatch.style.background = 'repeating-linear-gradient(45deg, rgba(255,107,122,0.16) 0 6px, #0a0e14 6px 12px)';
  }
  el('screenColorText').innerHTML =
    `<b>screen colour</b> (integrated XYZ)<br>` +
    (uncovered
      ? `unresolved: ${cov.zeroDensityBands.length + cov.insufficientBands.length} lit band(s) lack samples &mdash; supplement to read colour<br>reference XYZ (not an estimate) ${ref.xyz.map(fmtSci).join(' / ')}`
      : refDark
        ? `no light reaches the screen<br>XYZ ${ref.xyz.map(fmtSci).join(' / ')}`
        : `x ${xy[0].toFixed(4)} y ${xy[1].toFixed(4)}<br>XYZ ${ref.xyz.map(fmtSci).join(' / ')}`);

  const rows = [
    ['ΔE76 estimate vs reference', dE === null ? (uncovered ? 'n/a (unresolved)' : 'n/a (no light)') : dE.toFixed(4), dE === null ? (uncovered ? 'warn' : '') : dE < 1 ? 'ok' : dE < 3 ? 'warn' : 'err'],
    ['luminance ratio est/ref', Number.isFinite(lumRatio) ? lumRatio.toFixed(5) : uncovered ? 'n/a (unresolved)' : 'n/a', !Number.isFinite(lumRatio) ? '' : Math.abs(lumRatio - 1) < 0.01 ? 'ok' : 'warn'],
    ['scene white Y (normalised)', scene.sceneWhite[1].toFixed(4), ''],
    ['coverage of lit band', `${(cov.supportedFraction * 100).toFixed(1)}%`, cov.supported ? 'ok' : 'err'],
    ['zero-density bands', cov.zeroDensityBands.length ? cov.zeroDensityBands.map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}`).join(', ') : 'none', cov.zeroDensityBands.length ? 'err' : 'ok'],
    ['under-supported bands', cov.insufficientBands.length ? cov.insufficientBands.map((b) => `${b.a.toFixed(0)}-${b.b.toFixed(0)}`).join(', ') : 'none', cov.insufficientBands.length ? 'warn' : 'ok'],
    ['path-blocked samples (TIR)', String(est.blockedSamples), est.blockedSamples > 0 ? 'warn' : ''],
    ['filtered-out samples', String(est.filteredSamples), ''],
    ['screen bins flagged', String(est.screen ? est.screen.bins.filter((b) => b.unresolved).length : 0), est.screen && est.screen.bins.some((b) => b.unresolved) ? 'err' : ''],
  ];
  el('resultStats').innerHTML = rows.map(([k, v, cls]) =>
    `<dt>${k}</dt><dd class="${cls}">${v}</dd>`).join('');

  const supBtn = el('supplement');
  const needs = cov.zeroDensityBands.length > 0 || cov.insufficientBands.length > 0;
  supBtn.disabled = !needs;
  supBtn.classList.toggle('primary', needs);
  supBtn.textContent = cov.zeroDensityBands.length
    ? `Supplement ${cov.zeroDensityBands.length} empty band(s)`
    : cov.insufficientBands.length
      ? `Top up ${cov.insufficientBands.length} thin band(s)`
      : 'Supplement unsupported bands';
}

function norm(xyz) {
  if (!(xyz[1] > 0)) return [0, 0, 0];
  return [xyz[0] / xyz[1], 1, xyz[2] / xyz[1]];
}

function averageScreenXyz(est) {
  if (!est.screen) return [0, 0, 0];
  let X = 0, Y = 0, Z = 0;
  for (const b of est.screen.bins) { X += b.xyz[0]; Y += b.xyz[1]; Z += b.xyz[2]; }
  return [X, Y, Z];
}

// ---------------------------------------------------------------------------
// Contribution table
// ---------------------------------------------------------------------------

function renderTable() {
  const tbody = el('contrib').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = [];
  if (state.tableScope === 'estimate' && lastEstimate) {
    for (const r of lastEstimate.rows) {
      rows.push({
        lambda: r.lambda,
        batch: r.batchLabel || `batch ${r.batchId}`,
        pdf: r.pdf,
        L: r.L,
        T: r.T,
        f: r.filterT,
        screenY: r.screenY,
        xyz: r.xyz,
      });
    }
  } else if (lastReference) {
    for (const r of lastReference.rows) {
      // Reference rows are integrated over a fine scan; scale so the column
      // meaning (energy contribution) is comparable in shape to the estimate.
      rows.push({ lambda: r.lambda, batch: 'reference', pdf: 1, L: r.L, T: r.T, f: r.f, screenY: r.screenY, xyz: [r.scale * r.cmf[0], r.scale * r.cmf[1], r.scale * r.cmf[2]] });
    }
  }
  // Sort by wavelength for readability; cap for performance.
  rows.sort((a, b) => a.lambda - b.lambda);
  const cap = 800;
  const shown = rows.length > cap ? sampleRows(rows, cap) : rows;
  const peak = Math.max(1e-30, ...shown.map((r) => Math.max(r.xyz[0], r.xyz[1], r.xyz[2])));
  const frag = document.createDocumentFragment();
  for (const r of shown) {
    const tr = document.createElement('tr');
    const chip = scene.display.toSrgb(r.xyz.map((v) => v / peak)).rgb;
    tr.innerHTML = `
      <td>${r.lambda.toFixed(1)}</td>
      <td>${escapeHtml(r.batch)}</td>
      <td>${fmtSci(r.pdf)}</td>
      <td>${fmtSci(r.L)}</td>
      <td>${r.T.toFixed(4)}</td>
      <td>${r.f.toFixed(3)}</td>
      <td>${r.screenY === null ? '—' : r.screenY.toFixed(3)}</td>
      <td>${r.xyz.map(fmtSci).join(' / ')}</td>
      <td class="chip"><span class="chipSwatch" style="background:rgb(${chip.map((c) => Math.round(c * 255)).join(',')})"></span></td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function sampleRows(rows, cap) {
  const stride = rows.length / cap;
  const out = [];
  for (let i = 0; i < cap; i++) out.push(rows[Math.floor(i * stride)]);
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Verification panel
// ---------------------------------------------------------------------------

function renderChecks() {
  const results = runChecks({ scene, estimate: lastEstimate, reference: lastReference, state, VIEW });
  const root = el('checkList');
  root.innerHTML = '';
  for (const c of results) {
    const div = document.createElement('div');
    div.className = 'check';
    div.innerHTML = `
      <div class="row"><span class="name">${escapeHtml(c.name)}</span><span class="badge ${c.status}">${c.status}</span></div>
      <div class="val">${escapeHtml(c.value ?? '')}</div>
      <div class="detail">${escapeHtml(c.detail ?? '')}</div>`;
    root.appendChild(div);
  }
}

// Expose a tiny handle for automated UI tests. It returns the same structures the
// UI renders, so a browser test can assert on real numbers, not pixels alone.
window.__spectralLab = {
  getState: () => ({ ...state }),
  getScene: () => scene && {
    sourceKind: scene.source.kind,
    geometry: scene.geometry.kind,
    material: scene.geometry.material?.name,
    signature: scene.geometry.signature,
    sceneWhite: scene.sceneWhite,
  },
  getEstimate: () => lastEstimate && {
    xyz: lastEstimate.xyz,
    coverage: {
      supportedFraction: lastEstimate.coverage.supportedFraction,
      zeroDensityBands: lastEstimate.coverage.zeroDensityBands,
      insufficientBands: lastEstimate.coverage.insufficientBands,
    },
    sampleCount: scene.accumulator.sampleCount,
    rows: lastEstimate.rows.length,
    blockedSamples: lastEstimate.blockedSamples,
  },
  getReference: () => lastReference && { xyz: lastReference.xyz, rows: lastReference.rows.length },
  getChecks: () => runChecks({ scene, estimate: lastEstimate, reference: lastReference, state, VIEW }),
  getError: () => lastError && String(lastError),
  setState: (patch) => {
    // A filter-only change must go through the accumulate/re-estimate path so old
    // samples are reweighted rather than discarded. Anything that changes the
    // sampling setup legitimately forces a fresh draw.
    const samplingKeys = ['lamp', 'sampling', 'samples', 'optics', 'material', 'dispersion', 'apex', 'incidence'];
    const forces = Object.keys(patch).some((k) => samplingKeys.includes(k));
    Object.assign(state, patch);
    syncControls();
    rebuild({ forceResample: forces });
  },
  supplement: () => supplementBands(),
  resample: () => rebuild({ forceResample: true }),
};

init();
