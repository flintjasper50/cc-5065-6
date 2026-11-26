// Exposure accumulator.
//
// The accumulator owns the wavelength samples used to estimate the display
// color. Each stored sample keeps, at the moment it was drawn:
//   - lambda          the sampled wavelength
//   - pdf             the proposal density it was drawn from (1/nm)
//   - batch           the batch id and stratum
//   - contribution    the energy it contributed to X, Y, Z under the filter
//                     and geometry that were active then
//
// Estimation combines batches with the balance-heuristic multiple importance
// sampling (MIS) estimator, unbiased for any proposal mixture that covers the
// integrand:
//
//     I = sum_i g(lambda_i) / sum_k n_k p_k(lambda_i),   g = L * T * f * cmf
//
// Changing the filter only changes g, so existing samples can be *re-estimated*
// under the new filter without redrawing. Where the new filter transmits but the
// proposal mixture has too little density, the band is reported as UNSUPPORTED.
// It is never rendered as an empty box at zero energy: it is flagged before the
// estimate can be trusted, and `supplement()` draws samples there.

import { makeGrid } from './light.js';

const Y_INDEX = 1;

function binaryBin(value, edges) {
  if (!(value >= edges[0] && value <= edges[edges.length - 1])) return -1;
  let lo = 0;
  let hi = edges.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= value) lo = mid;
    else hi = mid;
  }
  return lo;
}

export const DEFAULT_SUPPORT_SAMPLES = 8;
export const DEFAULT_NEGLIGIBLE_FRACTION = 1e-3;

export class ExposureAccumulator {
  constructor({
    source,
    spectralData,
    geometry,
    lambdaMin = 380,
    lambdaMax = 780,
    coverageBins = 200,
    minExpected = DEFAULT_SUPPORT_SAMPLES,
    negligibleFraction = DEFAULT_NEGLIGIBLE_FRACTION,
  }) {
    this.source = source;
    this.spectralData = spectralData;
    this.geometry = geometry;
    this.lambdaMin = lambdaMin;
    this.lambdaMax = lambdaMax;
    this.coverageBins = coverageBins;
    this.minExpected = minExpected;
    this.negligibleFraction = negligibleFraction;
    this.batches = [];
    this._traceCache = new Map();
    this._nextBatchId = 0;
  }

  get sampleCount() {
    return this.batches.reduce((n, b) => n + b.samples.length, 0);
  }

  setGeometry(geometry) {
    if (!this.geometry || geometry.signature !== this.geometry.signature) {
      this.geometry = geometry;
      this._traceCache.clear();
    }
    return this;
  }

  trace(lambda) {
    const key = Math.round(lambda * 1e4);
    const cached = this._traceCache.get(key);
    if (cached) return cached;
    const r = this.geometry.trace(lambda);
    const rec = r.ok
      ? {
          ok: true,
          T: r.T,
          screenY: r.screenHit ? r.screenHit[1] : null,
          n: r.n,
          path: r.path,
          deviationDeg: r.deviationDeg,
        }
      : { ok: false, reason: r.reason, n: r.n ?? null, screenY: null, T: 0 };
    this._traceCache.set(key, rec);
    return rec;
  }

  // Integrand g at one wavelength, with the geometry throughput folded in.
  integrand(lambda, filter) {
    const L = this.source.spd(lambda);
    if (!(L > 0)) return null;
    const tr = this.trace(lambda);
    if (!tr.ok || !(tr.T > 0)) return null;
    const f = filter ? filter.transmission(lambda) : 1;
    if (!(f > 0)) return null;
    return { L, T: tr.T, f, trace: tr };
  }

  // Store a batch. `samples` come from `sampler` and carry wavelengths; their
  // density is taken from the sampler unless already attached. The optional
  // `filter`/`screen` define the contribution recorded at draw time.
  addBatch(sampler, samples, { label = '', filter = null, screen = null } = {}) {
    const batchId = this._nextBatchId++;
    const screenBins = screen ? buildScreenBins(screen) : null;
    const stored = samples.map((s) => {
      const pdf = s.pdf ?? sampler.densityAt(s.lambda);
      const cmf = this.spectralData.cmf(s.lambda);
      const g = this.integrand(s.lambda, filter);
      let contribution = [0, 0, 0];
      let screenY = null;
      if (g) {
        const scale = g.L * g.T * g.f;
        contribution = [scale * cmf[0], scale * cmf[1], scale * cmf[2]];
        screenY = g.trace.screenY;
      }
      return {
        lambda: s.lambda,
        pdf,
        stratum: s.stratum ?? -1,
        batchId,
        storedContribution: contribution,
        storedScreenY: screenY,
        storedOk: !!g,
      };
    });
    if (screenBins) {
      for (const s of stored) {
        if (s.storedScreenY === null) continue;
        const i = binaryBin(s.storedScreenY, screenBins.edges);
        if (i < 0) continue;
        screenBins.xyz[i][0] += s.storedContribution[0];
        screenBins.xyz[i][1] += s.storedContribution[1];
        screenBins.xyz[i][2] += s.storedContribution[2];
        screenBins.cnt[i] += 1;
        screenBins.energy[i] += s.storedContribution[1];
      }
    }
    const batch = { id: batchId, sampler, label, samples: stored, n: stored.length };
    this.batches.push(batch);
    return batch;
  }

  mixtureDensity(lambda) {
    let D = 0;
    for (const b of this.batches) D += b.n * b.sampler.densityAt(lambda);
    return D;
  }

  // Coverage of the current proposal mixture against a filter's passband.
  //
  // Each bin gets independent flags so a dark region and a missing-sample region
  // are never confused:
  //   - emits:       the source has photometric energy here (filter-independent).
  //   - passes:      the filter transmits here.
  //   - unnecessary: !passes, or passes but the source genuinely emits nothing.
  //                  A filter stopband and a spectral gap are both legitimate zeros.
  //   - zeroDensity: passes + emits, but the proposal mixture is exactly 0 here.
  //                  This is the dangerous "empty box" and is always reported.
  //   - insufficient: passes + emits, mixture > 0 but < minExpected samples -- an
  //                  under-resolved region, reported separately.
  // `supported` = unnecessary || (!zeroDensity && expected >= minExpected).
  // Unsupported bins are surfaced as bands and never folded into the estimate as
  // if they were zero energy.
  coverageFor(filter) {
    const { lambdaMin, lambdaMax, spectralData } = this;
    const bins = this.coverageBins;
    const width = (lambdaMax - lambdaMin) / bins;
    const report = new Array(bins);
    const N = this.sampleCount;
    let maxSource = 0;
    for (let i = 0; i < bins; i++) {
      const a = lambdaMin + i * width;
      const b = a + width;
      const sourceEnergy = binSourceEnergy(this.source, spectralData, this.geometry, a, b);
      const pass = filter ? filterMidpoint(filter, a, b) : 1;
      report[i] = { a, b, sourceEnergy, pass, expected: 0 };
      if (sourceEnergy > maxSource) maxSource = sourceEnergy;
    }
    for (let i = 0; i < bins; i++) {
      const bin = report[i];
      const centre = 0.5 * (bin.a + bin.b);
      const D = this.mixtureDensity(centre);
      const S = N * D * width;
      const emits = maxSource > 0 && bin.sourceEnergy > this.negligibleFraction * maxSource;
      const passes = bin.pass > 1e-4;
      bin.expected = S;
      bin.emits = emits;
      bin.negligible = !emits || !passes;
      bin.zeroDensity = emits && passes && D <= 0;
      bin.insufficient = emits && passes && D > 0 && S < this.minExpected;
      bin.supported = bin.negligible || (!bin.zeroDensity && S >= this.minExpected);
    }
    const unsupported = report.filter((x) => !x.supported);
    const active = report.filter((x) => !x.negligible);
    const supportedActive = active.filter((x) => x.supported);
    const zeroDensityBands = groupBands(report.filter((x) => x.zeroDensity));
    const insufficientBands = groupBands(report.filter((x) => x.insufficient));
    return {
      bins: report,
      unsupported: groupBands(unsupported),
      zeroDensityBands,
      insufficientBands,
      unresolved: zeroDensityBands.length > 0,
      significantBins: active.length,
      supportedFraction: active.length === 0 ? 1 : supportedActive.length / active.length,
      supported: unsupported.length === 0,
      sampleCount: N,
      maxSource,
      minExpected: this.minExpected,
    };
  }

  // MIS estimate under `filter`. Contributions are recomputed from the stored
  // wavelengths, which is exactly the "re-estimate old samples under a new
  // filter" path. Screen binning uses the current geometry.
  estimate(filter, { screen = null } = {}) {
    const coverage = this.coverageFor(filter);
    const screenBins = screen ? buildScreenBins(screen) : null;
    const rows = [];
    let X = 0, Y = 0, Z = 0;
    let blocked = 0;
    let filteredOut = 0;
    for (const batch of this.batches) {
      for (const sample of batch.samples) {
        const cmf = this.spectralData.cmf(sample.lambda);
        const g = this.integrand(sample.lambda, filter);
        if (!g) {
          const tr = this.trace(sample.lambda);
          if (!tr.ok) blocked += 1;
          else filteredOut += 1;
          continue;
        }
        const D = this.mixtureDensity(sample.lambda);
        if (!(D > 0)) continue;
        const scale = (g.L * g.T * g.f) / D;
        const cX = scale * cmf[0];
        const cY = scale * cmf[1];
        const cZ = scale * cmf[2];
        X += cX; Y += cY; Z += cZ;
        const row = {
          lambda: sample.lambda,
          pdf: sample.pdf,
          storedPdf: sample.pdf,
          stratum: sample.stratum,
          batchId: sample.batchId,
          batchLabel: batch.label,
          L: g.L,
          T: g.T,
          filterT: g.f,
          mixDensity: D,
          cmf,
          xyz: [cX, cY, cZ],
          path: g.trace.path,
          screenY: g.trace.screenY,
          n: g.trace.n,
          deviationDeg: g.trace.deviationDeg ?? 0,
          storedContribution: sample.storedContribution,
        };
        rows.push(row);
        if (screenBins && row.screenY !== null) {
          const i = binaryBin(row.screenY, screenBins.edges);
          if (i >= 0) {
            screenBins.xyz[i][0] += cX;
            screenBins.xyz[i][1] += cY;
            screenBins.xyz[i][2] += cZ;
            screenBins.cnt[i] += 1;
            screenBins.energy[i] += row.xyz[1];
          }
        }
      }
    }

    // Screen bins fed by unsupported wavelength bands must not be drawn as
    // zero. Map each unsupported band's midpoint through the geometry.
    if (screenBins) {
      screenBins.unresolved = new Uint8Array(screenBins.count);
      for (const band of coverage.unsupported) {
        const mid = 0.5 * (band.a + band.b);
        const tr = this.geometry.trace(mid);
        if (tr.ok && tr.screenHit) {
          const i = binaryBin(tr.screenHit[1], screenBins.edges);
          if (i >= 0) screenBins.unresolved[i] = 1;
        }
      }
    }

    return {
      xyz: [X, Y, Z],
      coverage,
      screen: screenBins
        ? {
            ...screenBins,
            bins: screenBins.xyz.map((v, i) => ({
              y0: screenBins.edges[i],
              y1: screenBins.edges[i + 1],
              xyz: v,
              count: screenBins.cnt[i],
              unresolved: !!(screenBins.unresolved && screenBins.unresolved[i]),
            })),
          }
        : null,
      rows,
      blockedSamples: blocked,
      filteredSamples: filteredOut,
    };
  }

  // Add samples restricted to the bands the current mixture fails to cover.
  // Each band gets its own normalized proposal; MIS stays unbiased.
  supplement(filter, {
    count = 800,
    strategy = 'energy',
    rng = Math.random,
  } = {}) {
    const coverage = this.coverageFor(filter);
    const bands = coverage.unsupported.map((b) => ({ a: b.a, b: b.b }));
    if (bands.length === 0) return { added: 0, batches: [], bands: [] };
    const perBand = Math.max(1, Math.ceil(count / bands.length));
    const addedBatches = [];
    for (const band of bands) {
      const sampler = this.makeBandSampler(band, strategy, filter);
      const samples = [];
      for (let i = 0; i < perBand; i++) {
        const u = (i + rng()) / perBand;
        const lambda = sampler.quantile(u);
        samples.push({ lambda, pdf: sampler.densityAt(lambda), stratum: i });
      }
      addedBatches.push(this.addBatch(sampler, samples, {
        label: `supplement ${band.a.toFixed(1)}-${band.b.toFixed(1)}nm (${strategy})`,
        filter,
      }));
    }
    return { added: addedBatches.reduce((n, b) => n + b.n, 0), batches: addedBatches, bands };
  }

  makeBandSampler(band, strategy, filter) {
    const { a, b } = band;
    const { source, spectralData, geometry } = this;
    const ybar = (l) => spectralData.cmf(l)[1];
    let densityFn;
    if (strategy === 'uniform') {
      densityFn = () => 1;
    } else {
      densityFn = (l) => {
        if (l < a || l > b) return 0;
        const L = source.spd(l);
        if (!(L > 0)) return 0;
        const tr = geometry.trace(l);
        if (!tr.ok || !(tr.T > 0)) return 0;
        const f = filter ? filter.transmission(l) : 1;
        if (!(f > 0)) return 0;
        return L * tr.T * f * ybar(l);
      };
      const probe = makeGrid(a, b, Math.max(0.05, (b - a) / 32));
      let any = 0;
      for (const l of probe) any += densityFn(l);
      // No source energy in the band is a real zero, but still cover it so the
      // estimator observes the zero rather than inferring it from an empty box.
      if (!(any > 0)) densityFn = (l) => (l >= a && l <= b ? 1 : 0);
    }
    return new BandSampler(densityFn, a, b);
  }

  reset() {
    this.batches = [];
    this._traceCache.clear();
    this._nextBatchId = 0;
  }
}

// Normalized proposal on a single band, zero elsewhere.
export class BandSampler {
  constructor(densityFn, a, b, resolution = 0.1) {
    this.kind = 'band';
    this.lambdaMin = a;
    this.lambdaMax = b;
    this.resolution = resolution;
    const n = Math.max(2, Math.round((b - a) / resolution));
    const h = (b - a) / n;
    this.h = h;
    this.grid = new Float64Array(n + 1);
    this.dens = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      this.grid[i] = a + i * h;
      this.dens[i] = Math.max(0, densityFn(this.grid[i]));
    }
    this.cdfVals = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 1; i <= n; i++) {
      acc += 0.5 * (this.dens[i - 1] + this.dens[i]) * h;
      this.cdfVals[i] = acc;
    }
    if (!(acc > 0)) {
      for (let i = 0; i <= n; i++) this.dens[i] = 1;
      acc = 0;
      for (let i = 1; i <= n; i++) {
        acc += 0.5 * (this.dens[i - 1] + this.dens[i]) * h;
        this.cdfVals[i] = acc;
      }
    }
    this.total = acc;
    for (let i = 0; i <= n; i++) {
      this.dens[i] /= acc;
      this.cdfVals[i] /= acc;
    }
  }

  cdfAt(lambda) {
    if (lambda <= this.lambdaMin) return 0;
    if (lambda >= this.lambdaMax) return 1;
    const f = (lambda - this.lambdaMin) / this.h;
    const i = Math.min(Math.floor(f), this.grid.length - 2);
    const t = f - i;
    return this.cdfVals[i] + (this.cdfVals[i + 1] - this.cdfVals[i]) * t;
  }

  densityAt(lambda) {
    if (lambda <= this.lambdaMin || lambda >= this.lambdaMax) return 0;
    const f = (lambda - this.lambdaMin) / this.h;
    const i = Math.min(Math.floor(f), this.grid.length - 2);
    const t = f - i;
    return this.dens[i] * (1 - t) + this.dens[i + 1] * t;
  }

  quantile(u) {
    const uu = Math.min(Math.max(u, 0), 1 - 1e-12);
    let lo = 0;
    let hi = this.cdfVals.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cdfVals[mid] <= uu) lo = mid;
      else hi = mid;
    }
    const span = this.cdfVals[hi] - this.cdfVals[lo];
    const t = span > 0 ? (uu - this.cdfVals[lo]) / span : 0;
    return this.grid[lo] + (this.grid[hi] - this.grid[lo]) * t;
  }
}

function groupBands(unsupportedBins) {
  const bands = [];
  for (const bin of unsupportedBins) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.b - bin.a) < 1e-9) {
      last.b = bin.b;
      last.width = last.b - last.a;
      last.bins += 1;
    } else {
      bands.push({ a: bin.a, b: bin.b, width: bin.b - bin.a, bins: 1 });
    }
  }
  return bands;
}

function filterMidpoint(filter, a, b) {
  return filter.transmission(0.5 * (a + b));
}

// Photometric source energy in a bin, without any filter. Filter-independent so
// that a narrow passband cannot make the surrounding lit region look dark.
function binSourceEnergy(source, spectralData, geometry, a, b) {
  const n = 6;
  const h = (b - a) / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const l = a + i * h;
    const L = source.spd(l);
    if (!(L > 0)) continue;
    const tr = geometry.trace(l);
    if (!tr.ok || !(tr.T > 0)) continue;
    acc += (i === 0 || i === n ? 0.5 : 1) * L * tr.T * spectralData.cmf(l)[Y_INDEX];
  }
  return acc * h;
}

function integrandMagnitude(source, spectralData, filter, geometry, a, b) {
  const n = 6;
  const h = (b - a) / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const l = a + i * h;
    const L = source.spd(l);
    if (!(L > 0)) continue;
    const tr = geometry.trace(l);
    if (!tr.ok || !(tr.T > 0)) continue;
    const f = filter ? filter.transmission(l) : 1;
    if (!(f > 0)) continue;
    acc += (i === 0 || i === n ? 0.5 : 1) * L * tr.T * f * spectralData.cmf(l)[Y_INDEX];
  }
  return acc * h;
}

export function buildScreenBins({ yMin, yMax, count }) {
  const edges = new Float64Array(count + 1);
  const xyz = new Array(count);
  const cnt = new Int32Array(count);
  for (let i = 0; i <= count; i++) edges[i] = yMin + ((yMax - yMin) * i) / count;
  for (let i = 0; i < count; i++) xyz[i] = [0, 0, 0];
  const energy = new Float64Array(count);
  return { yMin, yMax, count, edges, xyz, cnt, energy };
}
