// Loads the derived CIE 1931 tables and Schott Sellmeier coefficients.
// Everything downstream consumes this single source of truth.

const CMF_START = 360;
const CMF_STOP = 830;

export class SpectralData {
  constructor(raw) {
    const { meta, cub, glasses } = raw;
    this.meta = meta;
    this.cmfStart = cub.start;
    this.cmfStop = cub.stop;
    this.cmfStep = 1;
    this.x = Float64Array.from(cub.x);
    this.y = Float64Array.from(cub.y);
    this.z = Float64Array.from(cub.z);
    this.glasses = Object.fromEntries(
      Object.entries(glasses).map(([name, g]) => [name, {
        name,
        sellmeier: g.sellmeier.slice(),
        rangeUm: g.rangeUm.slice(),
        nd: g.nd,
        source: g.source,
      }]),
    );
  }

  static async load(url = new URL('../../data/spectra/spectral-data.json', import.meta.url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`spectral data ${response.status}`);
    return new SpectralData(await response.json());
  }

  // Linear interpolation of the standard observer, exact 0 outside [360, 830].
  cmf(lambda) {
    if (!(lambda >= CMF_START && lambda <= CMF_STOP)) return [0, 0, 0];
    const f = lambda - CMF_START;
    const i = Math.min(Math.floor(f), this.x.length - 2);
    const t = f - i;
    return [
      this.x[i] + (this.x[i + 1] - this.x[i]) * t,
      this.y[i] + (this.y[i + 1] - this.y[i]) * t,
      this.z[i] + (this.z[i + 1] - this.z[i]) * t,
    ];
  }
}

export const OBSERVER_RANGE = Object.freeze([360, 830]);
export const CMF_LIMITS = Object.freeze({ start: CMF_START, stop: CMF_STOP });
