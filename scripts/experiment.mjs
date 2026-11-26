// CLI helper for the wavelength-strategy experiment. The graphical window (index.html)
// is the primary entry point; this script prints the same evidence the window uses
// so the chromaticity error and ray cost can be recomputed from the command line
// and checked into a report.
//
//   node scripts/experiment.mjs               # summary table + rule + blind test
//   node scripts/experiment.mjs --json        # full serialisable evidence
//   node scripts/experiment.mjs --samples 384 --screen-bins 128 --seed 7
//
// It runs the experiment in-process against the repository's spectral data; it
// does not start a server and does not touch the browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpectralData } from '../src/core/spectral-data.js';
import { runExperiment, experimentEvidence } from '../src/core/experiment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { json: false, samples: 256, screenBins: 192 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--samples') out.samples = Number(argv[++i]);
    else if (a === '--screen-bins') out.screenBins = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadData() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/spectra/spectral-data.json'), 'utf8'));
  return new SpectralData(raw);
}

const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function printSummary(result) {
  const { config, spectra, rule, blindEvaluation } = result;
  console.log(`Wavelength-strategy experiment — budget ${config.samples} samples/spectrum, seeds ${config.seeds.join('/')}, ${config.screenBins} screen bins, tolerances colour ΔE≤${config.tolerances.colourDeltaE}, omit≤${config.tolerances.omission}`);
  console.log(`Geometry: ${config.geometry.material} ${config.geometry.dispersionModel} prism, apex ${config.geometry.apexDeg}°, incidence ${config.geometry.incidenceDeg}°`);
  console.log('');
  console.log('spectrum        W(nm)  c=N·W/Lw   fixed ΔE  fix omit  fix rays   joint ΔE  jnt omit  jnt rays');
  for (const s of spectra) {
    const fr = s.runs.fixed;
    const jr = s.runs.joint;
    console.log(
      `${s.id.padEnd(14)} ${f(s.width, 1).padStart(6)} ${f(s.concentration, 1).padStart(9)}   `
      + `${f(fr.metrics.globalDeltaE).padStart(9)} ${f(fr.metrics.omission, 3).padStart(8)} ${String(fr.rays).padStart(8)}   `
      + `${f(jr.metrics.globalDeltaE).padStart(9)} ${f(jr.metrics.omission, 3).padStart(8)} ${String(jr.rays).padStart(8)}`,
    );
  }
  console.log('');
  console.log(`Calibrated rule (calibration half only, ${rule.points.length} spectra):`);
  console.log(`  use FIXED when c = N·W/Lw ≥ cStar, else JOINT response;  cStar = ${f(rule.cStar, 1)}`);
  console.log(`  calibration misclassifications: ${rule.errors}`);
  console.log('');
  const sum = blindEvaluation.summary;
  console.log(`Blind half (${sum.n} spectra, rule applied without reading these labels):`);
  console.log(`  rule↔measured disagreements: ${sum.disagreements}`);
  console.log(`  chosen strategy sufficient: ${sum.chosenSufficientCount}/${sum.n}`);
  console.log(`  mean colour ΔE      fixed ${f(sum.meanFixedColourDeltaE)}   joint ${f(sum.meanJointColourDeltaE)}`);
  console.log(`  mean composite ΔE   fixed ${f(sum.meanFixedCompositeDeltaE)}   joint ${f(sum.meanJointCompositeDeltaE)}`);
  console.log(`  mean dark-band omission fixed ${f(sum.meanFixedOmission, 3)}   joint ${f(sum.meanJointOmission, 3)}`);
  console.log(`  total rays chosen ${sum.totalChosenRays}  vs all-joint ${sum.totalJointRays}  vs all-fixed ${sum.totalFixedRays}  (ratio ${f(sum.chosenRayRatioVsJoint, 3)})`);
  console.log('');
  console.log('  per blind spectrum:');
  console.log('  id            c        decision  agree  chosen ΔE  chosen omit  fixed ΔE  joint ΔE');
  for (const r of blindEvaluation.rows) {
    console.log(
      `  ${r.id.padEnd(12)} ${f(r.concentration, 1).padStart(6)}  ${r.decision.padEnd(6)}  ${String(r.agree).padStart(5)}  `
      + `${f(r.chosenMetrics.globalDeltaE).padStart(9)}  ${f(r.chosenMetrics.omission, 3).padStart(10)}  ${f(r.fixed.globalDeltaE).padStart(8)}  ${f(r.joint.globalDeltaE).padStart(8)}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/experiment.mjs [--json] [--samples N] [--screen-bins N] [--seed N] [--out FILE]');
    console.log('  --seed fixes the first of the five Monte-Carlo seeds; the seed set is [s, s+11, s+22, s+33, s+44].');
    return;
  }
  const spectralData = loadData();
  const baseSeed = Number.isFinite(args.seed) ? args.seed : 11;
  const seeds = [baseSeed, baseSeed + 11, baseSeed + 22, baseSeed + 33, baseSeed + 44];
  const result = runExperiment({
    spectralData,
    samples: args.samples,
    screenBins: args.screenBins,
    seeds,
  });
  if (args.out) {
    const evidence = experimentEvidence(result);
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Wrote evidence to ${args.out}`);
  }
  if (args.json) {
    console.log(JSON.stringify(experimentEvidence(result), null, 2));
  } else {
    printSummary(result);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
