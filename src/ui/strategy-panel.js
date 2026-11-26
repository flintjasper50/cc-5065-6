// Graphical wavelength-strategy comparison for the lab window.
//
// This is the in-window counterpart of the CLI experiment: it runs both proposals
// on a real traced prism and draws two dispersion frames side by side plus the
// wavelength-contribution chart behind each frame. Anomalies are marked on the
// picture itself — empty lit bins on the dispersion frames, unsupported bands on
// the contribution chart — because the point of the comparison is to show *where*
// a strategy loses coverage, not to report it only as text.

import { deltaE76 } from '../core/colorimetry.js';
import { makeDisplayTransform, normalizeXyz, xyOfXyz } from '../core/colorimetry.js';
import { perPixelError } from '../core/strategies.js';

const FONT = '10px ui-monospace, monospace';
export const ANOMALY = {
  empty: 'rgba(255, 107, 122, 0.16)',
  emptyStripe: 'rgba(255, 107, 122, 0.55)',
  unsupported: 'rgba(255, 180, 84, 0.75)',
  okBand: 'rgba(124, 196, 255, 0.16)',
};

// Build a display transform for a spectrum whose reference XYZ is known, so the
// comparison frames share the same documented output transform as the main scene.
export function displayForReference(reference) {
  const white = normalizeXyz(reference.xyz);
  if (!(white[1] > 0)) return makeDisplayTransform([1, 1, 1]);
  return makeDisplayTransform(white);
}

// Draw one dispersion frame from the estimate's own screen bins. `anomalies`
// carries per-bin { empty, unresolved } flags derived from the reference image so
// an empty lit bin is hatched, never drawn as black.
export function drawDispersionFrame(canvas, { estimate, display, anomalies, label }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, W, H);
  const screen = estimate.screen;
  if (!screen || !screen.bins.length) {
    ctx.fillStyle = '#ff6b7a';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('no screen image', 8, 20);
    return;
  }

  let peak = 0;
  for (const bin of screen.bins) peak = Math.max(peak, bin.xyz[1]);
  const gain = peak > 0 ? 1 / peak : 0;
  const bins = screen.bins;
  const n = bins.length;
  const rowH = H / n;

  for (let i = 0; i < n; i++) {
    const bin = bins[i];
    const top = H - (i + 1) * rowH;
    const flag = anomalies?.[i];
    if (bin.unresolved) {
      ctx.fillStyle = ANOMALY.empty;
      ctx.fillRect(0, top, W, rowH + 1);
      ctx.strokeStyle = ANOMALY.emptyStripe;
      ctx.lineWidth = 1;
      for (let x = -H; x < W; x += 8) {
        ctx.beginPath();
        ctx.moveTo(x, top + rowH);
        ctx.lineTo(x + rowH, top);
        ctx.stroke();
      }
      continue;
    }
    if (bin.count === 0) {
      // Lit but no sample landed here: hatch, do not fill black.
      if (flag?.lit) {
        ctx.fillStyle = ANOMALY.empty;
        ctx.fillRect(0, top, W, rowH + 1);
        ctx.strokeStyle = ANOMALY.emptyStripe;
        for (let x = -H; x < W; x += 8) {
          ctx.beginPath();
          ctx.moveTo(x, top + rowH);
          ctx.lineTo(x + rowH, top);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, top, W, rowH + 1);
      }
      continue;
    }
    const { rgb } = display.toSrgb(bin.xyz.map((v) => v * gain));
    ctx.fillStyle = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
    ctx.fillRect(0, top, W, rowH + 1);
  }

  // Label the top edge.
  ctx.fillStyle = '#9fb0c8';
  ctx.font = FONT;
  ctx.fillText(label, 6, 12);
}

// Wavelength-contribution chart: per-bin detected energy (Y) for the estimate,
// with the reference overlaid, plus a marker over any band the strategy left
// unsupported. This is the "wavelength contribution" view: where samples actually
// put energy across λ, versus where the true spectrum puts it.
export function drawContributionChart(canvas, {
  run,
  reference,
  spectralData,
  lambdaMin = 380,
  lambdaMax = 780,
  label,
  anomalies = [],
}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 30, r: 8, t: 16, b: 18 };
  const box = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };
  ctx.strokeStyle = '#2a3446';
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

  const lx = (l) => box.x + ((l - lambdaMin) / (lambdaMax - lambdaMin)) * box.w;

  // Reference detected energy per nm, normalised.
  const refGrid = [];
  let refMax = 0;
  for (const r of reference.rows) {
    if (r.lambda < lambdaMin || r.lambda > lambdaMax) continue;
    const e = r.L * r.f * r.T * spectralData.cmf(r.lambda)[1];
    refGrid.push([r.lambda, e]);
    if (e > refMax) refMax = e;
  }
  const refNorm = refMax > 0 ? 1 / refMax : 0;

  // Estimate: sum of sample Y contribution per wavelength bin.
  const nBins = 96;
  const est = new Float64Array(nBins);
  for (const row of run.estimate.rows) {
    const i = Math.floor(((row.lambda - lambdaMin) / (lambdaMax - lambdaMin)) * nBins);
    if (i >= 0 && i < nBins) est[i] += row.xyz[1];
  }
  let estMax = 0;
  for (const v of est) estMax = Math.max(estMax, v);
  const estNorm = estMax > 0 ? 1 / estMax : 0;

  // Reference area fill.
  ctx.beginPath();
  refGrid.forEach(([l, e], i) => {
    const x = lx(l);
    const y = box.y + box.h - e * refNorm * box.h * 0.9;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  if (refGrid.length) {
    ctx.lineTo(lx(refGrid.at(-1)[0]), box.y + box.h);
    ctx.lineTo(lx(refGrid[0][0]), box.y + box.h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(124,196,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,196,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Estimate bars.
  const bw = box.w / nBins;
  for (let i = 0; i < nBins; i++) {
    const v = est[i] * estNorm;
    if (v <= 0) continue;
    const x = box.x + i * bw;
    const h = v * box.h * 0.9;
    ctx.fillStyle = 'rgba(255,212,121,0.75)';
    ctx.fillRect(x, box.y + box.h - h, Math.max(1, bw - 0.5), h);
  }

  // Anomaly markers: unsupported bands overlaid as a hatched column.
  for (const band of anomalies) {
    const a = Math.max(lambdaMin, band.a);
    const b = Math.min(lambdaMax, band.b);
    if (b <= a) continue;
    const x0 = lx(a);
    const x1 = lx(b);
    ctx.fillStyle = ANOMALY.unsupported;
    ctx.fillRect(x0, box.y, Math.max(1.5, x1 - x0), box.h);
    ctx.strokeStyle = 'rgba(255,180,84,0.9)';
    ctx.lineWidth = 1;
    for (let x = x0 - box.h; x < x1; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, box.y + box.h);
      ctx.lineTo(x + box.h * 0.5, box.y + box.h - box.h * 0.5);
      ctx.stroke();
    }
  }

  // Axis ticks.
  ctx.fillStyle = '#8a97ac';
  ctx.font = FONT;
  ctx.textAlign = 'center';
  for (let l = 400; l <= 750; l += 50) {
    ctx.fillText(String(l), lx(l), H - 5);
  }
  ctx.textAlign = 'left';
  ctx.fillText('Y(λ)', 4, box.y + 8);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText(label, box.x + 4, box.y + 10);
}

// Convenience: anomaly flags per screen bin from the reference image.
export function frameAnomalies(estimate, referenceImage) {
  if (!referenceImage) return [];
  return perPixelError({ estimate, referenceImage });
}

export function compositeOf(run, reference) {
  const m = run.metrics;
  return {
    globalDeltaE: m.globalDeltaE,
    pixelDeltaE: m.pixelDeltaE,
    compositeDeltaE: m.compositeDeltaE,
    omission: m.omission,
    darkBins: m.darkBins,
    rays: run.rays,
    proposalRays: run.proposalRays,
  };
}

export { deltaE76, xyOfXyz };
