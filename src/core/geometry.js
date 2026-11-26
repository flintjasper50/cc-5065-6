// Geometry provider consumed by the exposure accumulator and the renderer.
// A geometry is a pure function lambda -> ray result, plus a cache-friendly
// signature. Changing any parameter that affects the light path changes the
// signature, which invalidates cached traces in the accumulator.

import { makeMaterial, tracePrism, traceStraight, prismVertices, analyticDeviationDeg } from './optics.js';

export const VIEW = Object.freeze({
  xMin: -1.35,
  xMax: 2.65,
  yMin: -2.35,
  yMax: 0.55,
  screenX: 2.45,
  prismFaceLength: 0.9,
  beamStartX: -1.2,
});

export function makeGeometry({ optics, material, spectralData, dispersionModel, apexDeg, incidenceDeg, entryFraction }) {
  if (optics === 'none') {
    const signature = `straight|${VIEW.screenX}`;
    return {
      kind: 'straight',
      signature,
      screenX: VIEW.screenX,
      prism: null,
      material: { name: 'vacuum', nd: 1 },
      trace(lambda) {
        return traceStraight(lambda, { screenX: VIEW.screenX, beamY: 0 });
      },
      describe: 'non-dispersive straight path',
    };
  }

  const mat = makeMaterial(material, spectralData, { model: dispersionModel });
  const params = {
    apexDeg,
    incidenceDeg,
    faceLength: VIEW.prismFaceLength,
    entryFraction,
    screenX: VIEW.screenX,
  };
  const signature = [
    'prism',
    material,
    dispersionModel,
    apexDeg.toFixed(3),
    incidenceDeg.toFixed(3),
    entryFraction.toFixed(4),
    VIEW.prismFaceLength,
    VIEW.screenX,
  ].join('|');
  // Pivot: the ray that hits the entry face at `entryFraction` travels along dIn
  // before that point; add that incoming segment so the beam starts at the left.
  const pivot = prismVertices(params);
  const c = Math.cos((apexDeg * Math.PI) / 360);
  const s = Math.sin((apexDeg * Math.PI) / 360);
  const dIn = [Math.cos((incidenceDeg * Math.PI) / 180 - (apexDeg * Math.PI) / 360), Math.sin((incidenceDeg * Math.PI) / 180 - (apexDeg * Math.PI) / 360)];
  return {
    kind: 'prism',
    signature,
    screenX: VIEW.screenX,
    prism: pivot,
    params,
    material: mat,
    incidence: { dIn, start: incomingStart(dIn, params), entryPoint: entryPointFor(params) },
    beamOrigin() { return incomingStart(dIn, params); },
    trace(lambda) {
      const r = tracePrism(lambda, mat, params);
      if (!r.ok) return r;
      // The ray enters where its path meets the left face, not at the fixed
      // pivot; prepend the incoming segment from the source to that hit.
      const start = incomingStartFor(r.dIn, r.entry);
      return { ...r, path: [start, ...r.path] };
    },
    deviationDeg(lambda) {
      return analyticDeviationDeg(mat.n(lambda), apexDeg, incidenceDeg);
    },
    describe: `${material}${dispersionModel === 'constant' ? ' (constant index)' : ''} prism, apex ${apexDeg}deg, incidence ${incidenceDeg}deg`,
  };
}

function entryPointFor(params) {
  const { left } = prismVertices(params);
  const f = params.entryFraction ?? 0.5;
  return [left[0] * f, left[1] * f];
}

function incomingStart(dIn, params) {
  return incomingStartFor(dIn, entryPointFor(params));
}

// Walk the ray backwards from its prism entry until it leaves the left side of
// the frame. Keeps the drawn incoming beam attached to the actual hit point.
function incomingStartFor(dIn, entry) {
  const dx = dIn[0];
  let t = dx !== 0 ? (VIEW.beamStartX - entry[0]) / dx : 0;
  t = Math.min(t, 0);
  return [entry[0] + t * dIn[0], entry[1] + t * dIn[1]];
}
