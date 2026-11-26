// Wavelength sampling with a recorded density. Samples always carry the density
// they were drawn from, so the exposure accumulator can later reweight them under
// a different filter without changing the estimator's meaning.

import { makeGrid } from './light.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Piecewise-linear CDF over a uniform wavelength grid, built from an arbitrary
// non-negative density. Sampling is by inverse CDF, so it works for any shape.
export class DensitySampler {
  constructor(densityFn, { lambdaMin = 380, lambdaMax = 780, resolution = 0.25, kind = 'custom' } = {}) {
    this.kind = kind;
    this.lambdaMin = lambdaMin;
    this.lambdaMax = lambdaMax;
    this.resolution = resolution;
    const grid = makeGrid(lambdaMin, lambdaMax, resolution);
    const dens = new Float64Array(grid.length);
    for (let i = 0; i < grid.length; i++) dens[i] = Math.max(0, densityFn(grid[i]));
    const cdf = new Float64Array(grid.length);
    let acc = 0;
    for (let i = 1; i < grid.length; i++) {
      acc += 0.5 * (dens[i - 1] + dens[i]) * resolution;
      cdf[i] = acc;
    }
    if (!(acc > 0)) throw new Error('sampling density is zero over the window');
    this.grid = grid;
    // Keep a normalized probability density so densityAt is a true PDF (units
    // 1/nm); MIS divides by the mixture of these PDFs.
    this.unnormalized = dens.slice();
    this.total = acc;
    for (let i = 0; i < dens.length; i++) dens[i] /= acc;
    this.densityGrid = dens;
    this.cdf = cdf;
    for (let i = 0; i < cdf.length; i++) cdf[i] /= acc;
  }

  densityAt(lambda) {
    const f = (lambda - this.lambdaMin) / this.resolution;
    if (f <= 0 || f >= this.grid.length - 1) return 0;
    const i = Math.floor(f);
    const t = f - i;
    return this.densityGrid[i] * (1 - t) + this.densityGrid[i + 1] * t;
  }

  // Exact piecewise-linear CDF value at lambda (integral of the density).
  cdfAt(lambda) {
    if (lambda <= this.lambdaMin) return 0;
    if (lambda >= this.lambdaMax) return 1;
    const f = (lambda - this.lambdaMin) / this.resolution;
    const i = Math.min(Math.floor(f), this.grid.length - 2);
    const t = f - i;
    return this.cdf[i] + (this.cdf[i + 1] - this.cdf[i]) * t;
  }

  quantile(u) {
    const uu = Math.min(Math.max(u, 0), 1 - 1e-12);
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] <= uu) lo = mid;
      else hi = mid;
    }
    const span = this.cdf[hi] - this.cdf[lo];
    const t = span > 0 ? (uu - this.cdf[lo]) / span : 0;
    const lambda = this.grid[lo] + (this.grid[hi] - this.grid[lo]) * t;
    return lambda;
  }

  // Equal-probability strata. Each sample records its stratum interval [lo, hi];
  // the interval is what later lets us audit *coverage* of a new filter band.
  drawStratified(count, rng = Math.random, { jitter = true } = {}) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const u0 = i / count;
      const u1 = (i + 1) / count;
      const u = jitter ? u0 + rng() * (u1 - u0) : 0.5 * (u0 + u1);
      const lambda = this.quantile(u);
      out[i] = {
        lambda,
        lo: this.quantile(u0),
        hi: this.quantile(u1),
        pdf: Math.max(this.densityAt(lambda), 1e-300),
      };
    }
    return out;
  }
}

export function uniformSampler(lambdaMin, lambdaMax, opts = {}) {
  return new DensitySampler(() => 1, { lambdaMin, lambdaMax, kind: 'uniform', ...opts });
}

// Source photometric energy density, optionally through a filter and with path
// throughput. This is the proposal for "energy stratified" sampling.
export function energyDensityFn(source, spectralData, { filter, geometry, includeFilter = false } = {}) {
  const ybar = (l) => spectralData.cmf(l)[1];
  return (lambda) => {
    const L = source.spd(lambda);
    if (!(L > 0)) return 0;
    let T = 1;
    if (geometry) {
      const r = geometry.trace(lambda);
      if (!r.ok) return 0;
      T = r.T;
    }
    if (!(T > 0)) return 0;
    const f = includeFilter && filter ? filter.transmission(lambda) : 1;
    return L * T * f * ybar(lambda);
  };
}

export function energySampler(source, spectralData, opts = {}) {
  return new DensitySampler(energyDensityFn(source, spectralData, opts), {
    lambdaMin: opts.lambdaMin ?? 380,
    lambdaMax: opts.lambdaMax ?? 780,
    resolution: opts.resolution ?? 0.25,
    kind: 'energy',
  });
}
