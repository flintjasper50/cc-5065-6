// Canvas drawing helpers: spectral plots (source SPD, filter, sampled points)
// and small UI primitives. All colors here come from the documented transform,
// except the wavelength axis ramp, which is explicitly a label ramp.

import { wavelengthLabelRgb } from '../core/colorimetry.js';

const AXIS_FONT = '11px ui-monospace, monospace';

export function clearCanvas(ctx, fill = '#0a0e14') {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

export function drawFrame(ctx, box, { stroke = '#2a3446', fill = null } = {}) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
}

// Plot the source SPD with the active filter overlay and the sampled wavelengths.
// Sampled points are drawn at their *sampled density* height, making the proposal
// density visible: stratifying by energy concentrates points where energy is.
export function drawSourcePlot(ctx, canvas, {
  source,
  spectralData,
  filter,
  samples = [],
  lambdaMin = 380,
  lambdaMax = 780,
  mode = 'spd',
}) {
  const W = canvas.width;
  const H = canvas.height;
  clearCanvas(ctx, '#0a0e14');
  const pad = { l: 34, r: 12, t: 14, b: 22 };
  const box = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };
  drawFrame(ctx, box);

  const lx = (l) => box.x + ((l - lambdaMin) / (lambdaMax - lambdaMin)) * box.w;
  const grid = [];
  const step = 0.5;
  let max = 0;
  for (let l = lambdaMin; l <= lambdaMax + 1e-9; l += step) {
    const v = Math.max(0, source.spd(l));
    grid.push([l, v]);
    if (v > max) max = v;
  }
  const norm = max > 0 ? 1 / max : 0;
  const vy = (v) => box.y + box.h - v * norm * box.h * 0.92;

  // Wavelength axis background ramp (label ramp only).
  ctx.save();
  ctx.globalAlpha = 0.16;
  for (let x = 0; x < box.w; x++) {
    const l = lambdaMin + (x / box.w) * (lambdaMax - lambdaMin);
    const rgb = wavelengthLabelRgb(l, spectralData);
    ctx.fillStyle = `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`;
    ctx.fillRect(box.x + x, box.y + box.h - 5, 1, 5);
  }
  ctx.restore();

  // Filter transmission band.
  if (filter) {
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let l = lambdaMin; l <= lambdaMax; l += 0.5) {
      const t = filter.transmission(l);
      if (t > 1e-4) {
        const x = lx(l);
        const y = box.y + box.h - t * box.h * 0.95;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    }
    if (started) {
      ctx.strokeStyle = 'rgba(255, 212, 121, 0.9)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    ctx.restore();
  }

  // SPD curve.
  ctx.beginPath();
  grid.forEach(([l, v], i) => {
    const x = lx(l);
    const y = vy(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#7cc4ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(124, 196, 255, 0.10)';
  ctx.fill();

  // Sample markers: scatter along lambda at their own radiance.
  ctx.save();
  for (const s of samples) {
    if (s.lambda < lambdaMin || s.lambda > lambdaMax) continue;
    const v = Math.max(0, source.spd(s.lambda)) * norm;
    const x = lx(s.lambda);
    const y = vy(v);
    const rgb = wavelengthLabelRgb(s.lambda, spectralData);
    ctx.fillStyle = `rgba(${rgb.map((c) => Math.round(c * 255)).join(',')},0.75)`;
    ctx.fillRect(x - 0.5, y, 1.4, box.y + box.h - y);
  }
  ctx.restore();

  // Axis labels.
  ctx.fillStyle = '#8a97ac';
  ctx.font = AXIS_FONT;
  ctx.textAlign = 'center';
  for (let l = 400; l <= 750; l += 50) {
    const x = lx(l);
    ctx.fillText(String(l), x, H - 6);
    ctx.strokeStyle = 'rgba(42,52,70,0.6)';
    ctx.beginPath();
    ctx.moveTo(x, box.y + box.h);
    ctx.lineTo(x, box.y + box.h + 3);
    ctx.stroke();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8a97ac';
  ctx.fillText('L(λ)', 8, box.y + 10);
  ctx.textAlign = 'right';
  ctx.fillText('nm', W - 6, H - 6);
  ctx.textAlign = 'left';

  return { box, lx, vy, norm };
}

export function drawSpectrumSummary(ctx, canvas, { title, subtitle }) {
  clearCanvas(ctx, '#0a0e14');
  ctx.fillStyle = '#dfe6f2';
  ctx.font = '12px ui-sans-serif, system-ui';
  ctx.fillText(title, 12, 20);
  ctx.fillStyle = '#8a97ac';
  ctx.font = AXIS_FONT;
  ctx.fillText(subtitle, 12, 38);
}
