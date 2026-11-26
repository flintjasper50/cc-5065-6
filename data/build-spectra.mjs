// Generates derived spectral tables from the source files in data/source.
// Sources: CVRL ciexyz31_1.csv (CIE 1931 2-deg CMFs, public) and
// refractiveindex.info Schott 2017 Sellmeier coefficients (CC0 / public domain).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'source');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spectra');
fs.mkdirSync(OUT, { recursive: true });

const rows = fs.readFileSync(path.join(SRC,'ciexyz31_1.csv'),'utf8')
  .trim().split(/\r?\n/).map(l=>l.split(',').map(Number));
const cub = {
  start: rows[0][0],
  stop: rows.at(-1)[0],
  x: rows.map(r=>r[1]), y: rows.map(r=>r[2]), z: rows.map(r=>r[3]),
};
const glasses = {
  'N-BK7': {
    sellmeier: [0,1.03961212,0.00600069867,0.231792344,0.0200179144,1.01046945,103.560653],
    rangeUm: [0.3,2.5],
    nd: 1.5168,
    abbe: 64.17,
    source: 'refractiveindex.info Schott 2017-01-20b, specs/schott/optical/N-BK7.yml',
  },
  'N-SF11': {
    sellmeier: [0,1.73759695,0.013188707,0.313747346,0.0623068142,1.89878101,155.23629],
    rangeUm: [0.37,2.5],
    nd: 1.78472,
    abbe: 25.76,
    source: 'refractiveindex.info Schott 2017-01-20b, specs/schott/optical/N-SF11.yml',
  },
};
const meta = {
  generated: '2026-11-26',
  cmf: {
    name: 'CIE 1931 2-deg standard observer',
    start: cub.start, stop: cub.stop, samples: rows.length,
    source: 'CVRL ciexyz31_1.csv, http://www.cvrl.org/database/data/cmfs/ciexyz31_1.csv',
  },
  glasses,
};
fs.writeFileSync(path.join(OUT,'spectral-data.json'), JSON.stringify({ meta, cub, glasses }));
console.log(JSON.stringify({ samples: rows.length, start: cub.start, stop: cub.stop, bytes: fs.statSync(path.join(OUT,'spectral-data.json')).size }));
