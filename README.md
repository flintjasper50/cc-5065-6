# Spectral Dispersion Lab

A wavelength-resolved light-transport prototype. It computes source energy, material
response and refractive index **per wavelength**, traces a real path through a prism
for each wavelength, and integrates the surviving light into a CIE 1931 XYZ colour
under a fixed observer and output transform. Dispersion is produced by **different
wavelengths following different paths** — there is no post-processing chromatic
aberration filter and no rainbow painted from three coloured rays.

## Launch the window

Requires Node.js (v18+) and any modern browser with ES modules.

```bash
node scripts/serve.mjs
```

Then open:

```
http://127.0.0.1:8080/
```

Set `PORT` to change the port, e.g. `PORT=9000 node scripts/serve.mjs`, and open
`http://127.0.0.1:9000/`.

The server serves the repository root so ES modules, JSON data and relative imports
resolve exactly as in a browser. There is no build step and no bundler; `index.html`
loads `./src/app/main.js` as `type="module"`. (Opening `index.html` straight from the
filesystem will not work — the browser blocks module and `fetch`/JSON access over
`file://`.)

## Run the verification suite

```bash
node --test tests/core.test.mjs
```

17 tests cover the CIE table, Sellmeier indices, the two-lamp white match, the
non-dispersion limit, dispersive screen spread, vector-vs-analytic deviation, Fresnel
bounds, total internal reflection, estimate-vs-independent-scan agreement (clear and
filtered), filter-switch re-estimation without resampling, coverage bookkeeping,
supplement convergence, the dark-gap ≠ zero-energy case, screen/whole-screen
consistency, filtered line position, and sampling-strategy variance.

Rebuild the derived spectral tables from the source files (only needed if you change
`data/source/`):

```bash
node data/build-spectra.mjs
```

## What the interface shows

- **Scene** — real per-wavelength polylines from the same trace the estimator uses.
  The rays are drawn from their computed paths; the colour tag is a label ramp, not
  the render colour.
- **Spectrum** — the source SPD, the filter transmission overlaid, and the actual
  sampled wavelengths.
- **Observed screen** — the dispersion image. If lit bands have no sample support the
  affected band is hatched and labelled *unresolved*; it is never drawn as black.
- **Energy & wavelength contributions** — one row per sample / scan step: wavelength,
  batch, proposal pdf, source L, path throughput T, filter transmission, screen y,
  and that sample's integrated XYZ plus its display colour chip. Toggle between the
  estimator (MIS) and the independent scan.
- **Verification** — the cross-checks, each with the number behind it.

## Colour pipeline

1. **Source energy** `L(λ)` — a Planck continuum, or three Gaussian lines whose
   weights are solved so both lamps integrate to the *same* scene white. The wide and
   narrow lamps therefore look identical (same xy) while their spectra differ sharply.
2. **Material response** — refractive index from the Schott Sellmeier equation
   (per wavelength) and unpolarized Fresnel transmittance at both prism faces.
3. **Path** — vector Snell refraction per wavelength, total internal reflection
   flagged explicitly (never silently absorbed).
4. **Integration** — `∫ L(λ)·T(λ)·filter(λ)·CMF(λ) dλ` to XYZ by multiple importance
   sampling with the balance heuristic. The estimate is reweighted from the stored
   samples for the current filter; bands with no support are reported, not zero-filled.
5. **Output transform** — relative XYZ → Bradford adaptation from scene white to D65 →
   linear sRGB → IEC 61966-2-1 OETF.

## Sampling and exposure accumulator

Each stored sample records its wavelength, the **density (pdf) that was in force when
it was drawn**, and its energy contribution. Because both the sample and its density
are kept, switching the filter re-estimates from old samples without resampling:

- A changed filter reweights the existing estimate. Samples in a band the new filter
  does not cover are reweighted to zero honestly.
- `coverageFor(filter)` classifies each band as: no source emission / blocked by the
  filter (legitimately dark), supported, **zero-density** (lit and passing but no
  sample landed there), or **under-supported** (too few samples). Zero-density and
  under-supported bands surface in the UI and enable **Supplement unsupported bands**,
  which draws fresh samples only in the missing bands while keeping MIS unbiased.
- An empty bin means *not sampled here*, never *zero energy here*. The UI shows such
  an estimate as **unresolved**, and withholds a colour rather than printing black.

## Data provenance and out-of-range policy

All spectral data comes from documented sources, embedded with its provenance in
`data/spectra/spectral-data.json`:

- **CIE 1931 2° standard observer** — CVRL `ciexyz31_1.csv`, 360–830 nm, 471 samples,
  linearly interpolated. **Outside 360–830 nm the CMF is exactly 0** — the integration
  never extrapolates the observer beyond its tabulated range.
- **Glasses** — Schott 2017-01-20b Sellmeier coefficients via refractiveindex.info
  (CC0 / public domain): N-BK7 (nd 1.5168, Abbe 64.17) and N-SF11 (nd 1.78472,
  Abbe 25.76).

Wavelengths are sampled over 380–780 nm. No spectral quantity is extrapolated outside
its stated range; the only "outside" behaviour is the explicit zero of the observer.

## Independent verification

`src/core/reference.js` is a separate uniform wavelength scan (default 0.1 nm) that
shares **no sampling code** with the estimator. It computes the same integral by direct
quadrature. The UI's first check compares the estimator's XYZ against it:

- Clear filter, wide lamp — ΔE76 ≈ 0.0000.
- Narrow passband — ΔE76 ≈ 0.0003 after supplementing.

The other checks compare the traced direction against the closed-form prism deviation,
Fresnel transmittance against physical bounds, the dispersive screen spread against a
constant-index model, coverage against the lit passband, the filtered emission-line
position against the geometry, and a live **uniform vs energy-stratified** sampling
comparison that reports both the luminance and the colour variance across seeds. The
sampling comparison is deliberately presented as an INFO trade-off, not a win: energy
sampling damps luminance variance because it targets the energy integrand, but it does
not automatically reduce colour (chromaticity) variance.

## Layout

```
index.html                 the lab window
scripts/serve.mjs          static server (node scripts/serve.mjs)
src/app/main.js            UI controller, state, renderers
src/core/                  spectral data, colorimetry, optics, light, sampling,
                           exposure accumulator, geometry, independent reference
src/ui/                    plots, verification checks, styles
data/source/               downloaded CMF CSV + Schott Sellmeier YAML
data/spectra/              derived spectral-data.json (provenance embedded)
data/build-spectra.mjs     rebuilds the derived tables
tests/                     core test suite + shared harness
```
