// Shared test harness. Loads the same modules the browser uses, from disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { SpectralData } from '../src/core/spectral-data.js';
import { buildLamps, createScene, makeProposal } from '../src/core/scene.js';
import { buildFilter } from '../src/core/light.js';
import { referenceScan, referenceScreen, lineCentroids } from '../src/core/reference.js';
import { deltaE76, integrateXyz, xyOfXyz } from '../src/core/colorimetry.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadData() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/spectra/spectral-data.json'), 'utf8'));
  return new SpectralData(raw);
}

export function makeWorld(spectralData) {
  const lamps = buildLamps(spectralData);
  return { spectralData, lamps };
}

export function sceneWithSamples(spectralData, lamps, params) {
  const scene = createScene(spectralData, { ...params, lamps });
  const proposal = makeProposal(scene.source, spectralData, scene.sampling.strategy, {
    geometry: scene.geometry,
    filter: scene.filter,
    lambdaMin: 380,
    lambdaMax: 780,
  });
  const drawn = proposal.drawStratified(scene.sampling.samples, undefined, { jitter: false });
  scene.accumulator.addBatch(proposal, drawn, { filter: scene.filter, label: `${scene.sampling.strategy} proposal` });
  return scene;
}

export function dEOf(a, b) {
  const na = a[1] > 0 ? [a[0] / a[1], 1, a[2] / a[1]] : [0, 0, 0];
  const nb = b[1] > 0 ? [b[0] / b[1], 1, b[2] / b[1]] : [0, 0, 0];
  if (!(a[1] > 0) && !(b[1] > 0)) return 0;
  if (!(a[1] > 0) || !(b[1] > 0)) return Infinity;
  return deltaE76(na, nb);
}

export { buildFilter, referenceScan, referenceScreen, lineCentroids, integrateXyz, xyOfXyz, assert };
