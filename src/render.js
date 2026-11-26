// Rendering: turn the estimated spectral image into pixels. Two outputs share
// one display transform:
//   1. the wavelength path diagram: per-sample polylines from the real geometry
//   2. the screen image: the integral over wavelength of radiance landing at each
//      screen position, converted through the documented output transform
// Neither draws an "RGB rainbow": colors come from integrated XYZ, and a label
// ramp is only ever used for legends and axis ticks.

import { VIEW, xyOfXyz } from './core/scene.js';
import { makeDisplayTransform } from './core/colorimetry.js';

const SCREEN_BINS = 300;

export function viewToCanvas(view, canvas, { padding = 0.04, world = VIEW } = {}) {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = world.xMax - world.xMin;
  const vh = world.yMax - world.yMin;
  const scale = Math.min(cw / vw, ch / vh) * (1 - 2 * padding);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  return {
    world,
    scale,
    x: (wx) => ox + (wx - world.xMin) * scale,
    y: (wy) => ch - oy - (wy - world.yMin) * scale,
    inverse: (px, py) => [
      (px - ox) / scale + world.xMin,
      world.yMin + (ch - oy - py) / scale,
    ],
  };
}

// Fit the view to the traced content: prism, screen and every probe path. This
// keeps a 2 nm line visible without misreporting where it lands.
export function fitView(geometry, probeWavelengths) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const take = ([x, y]) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  if (geometry.prism) take(geometry.prism.apex), take(geometry.prism.left), take(geometry.prism.right);
  if (geometry.kind === 'prism' && geometry.beamOrigin) take(geometry.beamOrigin());
  for (const lam of probeWavelengths) {
    const tr = geometry.trace(lam);
    if (tr.ok && tr.path) for (const p of tr.path) take(p);
  }
  take([VIEW.screenX, Math.min(...(geometry.prism ? [geometry.prism.left[1], geometry.prism.right[1]] : [-0.4])) ]);
  // Include off-screen screen span for range but do not let it dominate.
  if (!Number.isFinite(minX)) return VIEW;
  const padX = Math.max(0.18, (maxX - minX) * 0.06);
  const padY = Math.max(0.16, (maxY - minY) * 0.28);
  return {
    xMin: minX - padX,
    xMax: Math.max(maxX + padX, VIEW.screenX + 0.25),
    yMin: minY - padY,
    yMax: maxY + padY,
  };
}

// Draw the prism body, screen, and wavelength axis labels.
export function drawSceneBase(ctx, geometry, view, { theme }) {
  const world = view.world ?? VIEW;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Screen plane.
  const sx = view.x(world.screenX);
  ctx.fillStyle = theme.screen;
  ctx.fillRect(sx - 2, view.y(world.yMax), 4, view.y(world.yMin) - view.y(world.yMax));
  ctx.fillStyle = theme.screenLabel;
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('screen', sx + 8, view.y(world.yMax) + 16);

  if (geometry.kind === 'prism' && geometry.prism) {
    const { apex, left, right } = geometry.prism;
    ctx.beginPath();
    ctx.moveTo(view.x(apex[0]), view.y(apex[1]));
    ctx.lineTo(view.x(left[0]), view.y(left[1]));
    ctx.lineTo(view.x(right[0]), view.y(right[1]));
    ctx.closePath();
    ctx.fillStyle = theme.prismFill;
    ctx.fill();
    ctx.strokeStyle = theme.prismStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    // Non-dispersive medium slab across the beam.
    const x0 = view.x(-0.35);
    const x1 = view.x(0.35);
    const y0 = view.y(0.35);
    const y1 = view.y(-0.35);
    ctx.fillStyle = theme.slabFill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = theme.slabStroke;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = theme.screenLabel;
    ctx.fillText(geometry.kind === 'straight' ? 'vacuum' : 'non-dispersive', x0 + 4, y0 - 6);
  }

  // Beam origin marker at the real start of the incoming segment.
  let origin = [world.xMin + 0.06, 0];
  if (geometry.kind === 'prism' && geometry.beamOrigin) origin = geometry.beamOrigin();
  else if (geometry.kind === 'straight') origin = [world.xMin + 0.06, 0];
  const bx = view.x(origin[0]);
  const by = view.y(origin[1]);
  ctx.fillStyle = theme.sourceMarker;
  ctx.beginPath();
  ctx.arc(bx, by, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.35)';
  ctx.beginPath();
  ctx.arc(bx, by, 7, 0, Math.PI * 2);
  ctx.stroke();
}

// Draw the accumulated sample paths. `rows` are the estimate rows, each of which
// carries the real polyline geometry. Colors come from the sample's own XYZ
// contribution normalized for display; width is constant so brightness is
// carried by opacity, never by hue.
export function drawSamplePaths(ctx, rows, view, display, { theme, maxRows = 1200, pathAlpha = 0.05 }) {
  if (!rows.length) return;
  const stride = Math.max(1, Math.ceil(rows.length / maxRows));
  // Normalize sample colors by the brightest sample so single paths stay visible;
  // this is a display gain, not a change of chromaticity.
  let peak = 0;
  for (const row of rows) peak = Math.max(peak, row.xyz[1]);
  const gain = peak > 0 ? 1 / peak : 0;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < rows.length; i += stride) {
    const row = rows[i];
    if (!row.path || row.path.length < 2) continue;
    const { rgb } = display.toSrgb(row.xyz.map((v) => v * gain));
    ctx.strokeStyle = `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${pathAlpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < row.path.length; k++) {
      const [x, y] = row.path[k];
      const px = view.x(x);
      const py = view.y(y);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Render the screen image and estimate rows into a canvas. The estimate comes
// from ExposureAccumulator.estimate(filter, { screen }), so the image is the same
// spectral integral shown numerically; unresolved bins are hatched, never zeroed.
export function renderScreen(canvas, estimate, display, { theme, screenRange }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const { yMin, yMax } = screenRange;
  const s = estimate.screen;
  if (!s) return;

  // Peak luminance for display exposure. The screen image is the integral of
  // radiance landing in each y bin; dividing by the peak keeps it in [0,1] without
  // changing chromaticity.
  let peak = 0;
  for (const bin of s.bins) peak = Math.max(peak, bin.xyz[1]);
  const gain = peak > 0 ? 1 / peak : 0;

  const rowH = H / s.bins.length;
  for (let i = 0; i < s.bins.length; i++) {
    const bin = s.bins[i];
    // bin.y1 < bin.y0 since screen y increases upward; canvas y increases down.
    const top = H - (i + 1) * rowH;
    if (bin.unresolved) {
      ctx.fillStyle = theme.unresolved;
      ctx.fillRect(0, top, W, rowH + 1);
      ctx.strokeStyle = theme.unresolvedStripe;
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
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, top, W, rowH + 1);
      continue;
    }
    const xyz = bin.xyz.map((v) => v * gain);
    const { rgb } = display.toSrgb(xyz);
    ctx.fillStyle = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
    ctx.fillRect(0, top, W, rowH + 1);
  }
}

export function screenRangeFromView() {
  return { yMin: VIEW.yMin, yMax: VIEW.yMax, count: SCREEN_BINS };
}

export { xyOfXyz, makeDisplayTransform };
