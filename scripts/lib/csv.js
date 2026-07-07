import { readFileSync } from 'node:fs';

// Parses RFC-4180-ish CSV: quoted fields may contain commas, quotes ("" escape),
// and newlines. Source files have BOM and CRLF; both are normalized here.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Returns array of objects keyed by header row. Columns with an empty header
// name (relics.csv has one) are dropped.
export function readCSV(file) {
  const rows = parseCSV(readFileSync(file, 'utf8'));
  const header = rows[0];
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.every(f => f === '')) continue;
    const obj = {};
    header.forEach((h, i) => { if (h !== '') obj[h] = r[i] ?? ''; });
    out.push(obj);
  }
  return out;
}
