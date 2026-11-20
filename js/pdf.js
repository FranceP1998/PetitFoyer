// Crea il PDF del foglio turni (A4 orizzontale, una pagina) senza librerie esterne.
// Il PDF è vettoriale: nitido a qualsiasi ingrandimento e identico su Mac, iPhone, Android e stampante.
// Stesse regole grafiche del foglio a schermo (grid.js): due righe per operatore, caselle quadrate,
// striscia bianca tra un operatore e l'altro, sbarra della notte, domeniche gialle, ecc.

import { giorniDelMese, meseDopo, nomeMese, pad, iso, righeLegenda } from './grid.js';
import { LARGHEZZE } from './pdf-metrics.js';

const MM = 72 / 25.4;               // punti PDF per millimetro
const PW = 297, PH = 210;           // A4 orizzontale, mm

// ----------------------------------------------------------------- impaginazione
const MARGINE_X = 12;               // margine minimo a sinistra e a destra (mm)
const MARGINE_Y = 10;               // margine minimo sopra e sotto (mm)
const K_NOME = 4.3;                 // larghezza colonna nomi, in "caselle"
const K_GAP = 0.25;                 // striscia bianca tra operatori, in "caselle"
const K_HEAD = 0.8;                 // altezza di ogni riga d'intestazione (L M M G… e 1 2 3…), in "caselle"

const COLORI = { giallo: '#fff2a8', arancio: '#ffd9a0', azzurro: '#c9ebf7', nero: '#111111', grigio: '#9a9a9a' };
const SOTTILE = 0.22, FORTE = 0.6;  // spessore delle linee (mm)
const LETTERE = ['D', 'L', 'M', 'M', 'G', 'V', 'S'];
const FULL_DAY = ['PERM', 'F', 'FS', 'RR', 'R'];

// ----------------------------------------------------------------- testo e font
const FONT = { H: '/F1', B: '/F2', I: '/F3', T: '/F4' };                 // Helvetica, Bold, Oblique, Times-Italic
const METRICA = { H: LARGHEZZE.H, B: LARGHEZZE.B, I: LARGHEZZE.H, T: LARGHEZZE.T };
const WIN = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

function byteDi(ch) {
  if (WIN[ch]) return WIN[ch];
  const c = ch.charCodeAt(0);
  if (c >= 32 && c < 256 && !(c >= 0x7f && c <= 0x9f)) return c;
  const base = ch.normalize('NFD').charCodeAt(0);        // lettera accentata non codificabile → lettera semplice
  return base >= 32 && base < 127 ? base : 63;           // altrimenti "?"
}
const codifica = (s) => Array.from(String(s ?? '')).map((ch) => String.fromCharCode(byteDi(ch))).join('');
const larghezza = (s, f, pt) => Array.from(codifica(s)).reduce((a, ch) => a + (METRICA[f][ch.charCodeAt(0) - 32] ?? 556), 0) * pt / 1000;   // in punti
const lMM = (s, f, pt) => larghezza(s, f, pt) / MM;
const esc = (s) => codifica(s).replace(/([\\()])/g, '\\$1');
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

// ----------------------------------------------------------------- pagina (coordinate in mm, origine in alto a sinistra)
class Pagina {
  constructor() { this.c = []; }
  X(x) { return num(x * MM); }
  Y(y) { return num((PH - y) * MM); }
  fill(x, y, w, h, hex) { this.c.push(`${rgb(hex)} rg ${this.X(x)} ${this.Y(y + h)} ${num(w * MM)} ${num(h * MM)} re f`); }
  linea(x1, y1, x2, y2, sp = SOTTILE, { hex = COLORI.nero, tratteggio = null, cap = 0 } = {}) {
    this.c.push(`${rgb(hex)} RG ${num(sp * MM)} w ${cap} J ${tratteggio ? `[${tratteggio.map((v) => num(v * MM)).join(' ')}] 0 d` : '[] 0 d'} ` +
      `${this.X(x1)} ${this.Y(y1)} m ${this.X(x2)} ${this.Y(y2)} l S`);
  }
  rettangolo(x, y, w, h, sp = SOTTILE, hex = COLORI.nero) {
    this.c.push(`${rgb(hex)} RG ${num(sp * MM)} w [] 0 d ${this.X(x)} ${this.Y(y + h)} ${num(w * MM)} ${num(h * MM)} re S`);
  }
  cerchio(cx, cy, r, sp) {
    const k = 0.5523 * r, X = (v) => this.X(v), Y = (v) => this.Y(v);
    this.c.push(`${rgb(COLORI.nero)} RG ${num(sp * MM)} w [] 0 d ${X(cx + r)} ${Y(cy)} m ` +
      `${X(cx + r)} ${Y(cy - k)} ${X(cx + k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ` +
      `${X(cx - k)} ${Y(cy - r)} ${X(cx - r)} ${Y(cy - k)} ${X(cx - r)} ${Y(cy)} c ` +
      `${X(cx - r)} ${Y(cy + k)} ${X(cx - k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ` +
      `${X(cx + k)} ${Y(cy + r)} ${X(cx + r)} ${Y(cy + k)} ${X(cx + r)} ${Y(cy)} c S`);
  }
  // testo con la linea di base a y (mm). align: 'l' | 'c' | 'r' rispetto a x
  immagine(x, y, w, h) { this.c.push(`q ${num(w * MM)} 0 0 ${num(h * MM)} ${this.X(x)} ${this.Y(y + h)} cm /Im1 Do Q`); }
  testo(s, x, yBase, f, pt, align = 'l', hex = COLORI.nero) {
    if (s === '' || s == null) return;
    const w = lMM(s, f, pt);
    const x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
    this.c.push(`BT ${rgb(hex)} rg ${FONT[f]} ${num(pt)} Tf ${this.X(x0)} ${this.Y(yBase)} Td (${esc(s)}) Tj ET`);
  }
  // testo centrato in orizzontale e in verticale rispetto al punto (cx, cy); l'altezza delle maiuscole è ~0,72 del corpo
  testoCentro(s, cx, cy, f, pt, hex) { this.testo(s, cx, cy + 0.36 * pt / MM, f, pt, 'c', hex); }
}

// ----------------------------------------------------------------- PDF
function costruisciPdf(pagina, titolo, logo) {
  const contenuto = pagina.c.join('\n') + '\n';
  const oggetti = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PW * MM)} ${num(PH * MM)}] /Contents 4 0 R ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >>${logo ? ' /XObject << /Im1 10 0 R >>' : ''} >> >>`,
    `<< /Length ${contenuto.length} >>\nstream\n${contenuto}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>',
    `<< /Title (${esc(titolo)}) /Producer (Turni Petit Foyer) >>`,
  ];
  if (logo) {                                                  // immagine RGB non compressa (il logo è piccolo)
    let dati = '';
    for (let i = 0; i < logo.rgb.length; i += 8192) dati += String.fromCharCode.apply(null, logo.rgb.subarray(i, i + 8192));
    oggetti.push(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate true /Length ${logo.rgb.length} >>\nstream\n${dati}\nendstream`);
  }
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  oggetti.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${oggetti.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${oggetti.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ----------------------------------------------------------------- disegno del foglio
export function nomeFilePdf(year, month) { return `Turni-${nomeMese(month)}-${year}.pdf`; }

// opzioni: { year, month, staff, shifts, events, servizio, note }
// logo (facoltativo): { w, h, rgb } con i pixel RGB già composti su fondo bianco
export function creaPdf({ year, month, staff, shifts, events, servizio = '', note = '', logo = null }) {
  const nGiorni = giorniDelMese(year, month);
  const next = meseDopo(year, month);
  const persone = [...staff].filter((p) => p.active !== false).sort((a, b) => a.sort_order - b.sort_order);
  const n = persone.length;
  const nCol = nGiorni + 1;                                    // giorni del mese + 1° del mese dopo

  const idx = new Map();
  for (const s of shifts) {
    const k = `${s.staff_id}|${s.date}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ kind: s.kind, requested: !!s.requested });
  }
  const get = (sid, data) => idx.get(`${sid}|${data}`) || [];

  const cols = [];
  for (let d = 1; d <= nCol; d++) {
    const extra = d === nCol;
    const yy = extra ? next.y : year, mm = extra ? next.m : month, dd = extra ? 1 : d;
    const data = iso(yy, mm, dd);
    const dow = new Date(yy, mm - 1, dd).getDay();
    const ev = events.filter((e) => e.date === data);
    cols.push({ d, extra, data, dow, dd, mm, yy, sun: dow === 0, wk: dow === 0 || extra,
      coll: ev.some((e) => e.kind === 'collettivo'), spesa: ev.some((e) => e.kind === 'spesa') });
  }

  // ---- testi sopra e sotto la tabella (altezze fisse, in mm)
  const legenda = righeLegenda(events, year, month);
  const H_MARCHIO = 12, H_SERVIZIO = 12, H_RIGA_LEG = 5.4, H_OSS_RIGA = 5.6;
  const PT_OSS = 9.5;

  // ---- dimensione delle caselle: la più grande che sta in larghezza E in altezza
  const utileX = PW - 2 * MARGINE_X;
  const utileY = PH - 2 * MARGINE_Y;
  const unitaAltezza = 2 * K_HEAD + 2 * n + K_GAP * n;          // c'è una striscia bianca anche sotto l'intestazione
  const righeOss = (s) => {                                    // a capo semplice sulla larghezza della pagina
    const parole = String(s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const maxW = utileX - 28;
    const righe = []; let r = '';
    for (const p of parole) {
      const prova = r ? r + ' ' + p : p;
      if (lMM(prova, 'H', PT_OSS) > maxW && r) { righe.push(r); r = p; } else r = prova;
    }
    if (r) righe.push(r);
    return righe.slice(0, 3).length ? righe.slice(0, 3) : [''];
  };
  const lineeOss = righeOss(note);
  const fissoAlto = H_MARCHIO + H_SERVIZIO + legenda.length * H_RIGA_LEG + 3;
  const fissoBasso = 5 + lineeOss.length * H_OSS_RIGA;
  const sLarg = utileX / (K_NOME + nCol);
  const sAlt = (utileY - fissoAlto - fissoBasso) / unitaAltezza;
  const s = Math.min(sLarg, sAlt, 9);
  const nomeW = K_NOME * s, gap = K_GAP * s, hh = K_HEAD * s;
  const tabW = nomeW + nCol * s;
  const tabH = 2 * hh + 2 * s * n + gap * n;
  const totH = fissoAlto + tabH + fissoBasso;
  const xL = (PW - tabW) / 2;                                 // tutto il blocco è centrato nella pagina
  const yTop = Math.max(MARGINE_Y, (PH - totH) / 2);
  const xR = xL + tabW;

  const pg = new Pagina();

  // ---------------------------------------------------------------- intestazione
  let y = yTop;
  const hLogo = 10.2, wLogo = logo ? hLogo * logo.w / logo.h : 0;
  if (logo) pg.immagine(xL, y + 0.4, wLogo, hLogo);
  const xT = xL + (logo ? wLogo + 2.5 : 0);
  pg.testo('LA LIBELLULA', xT, y + 5.4, 'B', 13);
  pg.testo('Società Cooperativa Sociale', xT, y + 9.2, 'B', 7.5);
  pg.testo('Programmazione mensile dei turni', xR, y + 9, 'T', 12, 'r');
  pg.linea(xL, y + 10.8, xR, y + 10.8, 0.45);
  y += H_MARCHIO;

  // Servizio / Mese di, con la riga a puntini
  const puntini = (xa, xb, yb, valore) => {
    pg.linea(xa, yb + 0.9, xb, yb + 0.9, 0.22, { hex: '#555555', tratteggio: [0.25, 0.7], cap: 1 });
    pg.testo(valore, xa + 2, yb, 'B', 10);
  };
  const yS = y + 8.2;
  pg.testo('Servizio:', xL + 1, yS, 'B', 10);
  puntini(xL + 1 + lMM('Servizio: ', 'B', 10), xL + 1 + lMM('Servizio: ', 'B', 10) + 52, yS, servizio);
  const meseTxt = `${nomeMese(month).toUpperCase()} ${year}`;
  const xMeseA = xR - 1 - 52;
  pg.testo('Mese di:', xMeseA - lMM('Mese di: ', 'B', 10), yS, 'B', 10);
  puntini(xMeseA, xR - 1, yS, meseTxt);
  y += H_SERVIZIO;

  // legenda
  for (const r of legenda) {
    const PT = 9;
    const yb = y + 3.9;
    const bg = r.cls === 'collettivo' ? COLORI.azzurro : r.cls === 'spesa' ? COLORI.giallo : null;
    const wIcona = r.icona ? 5.2 : 0;
    const w = wIcona + lMM(r.b, 'B', PT) + lMM(r.t, 'H', PT) + 3;
    if (bg) pg.fill(xL + 1, y + 0.3, w, H_RIGA_LEG - 0.8, bg);
    let xc = xL + 2.5;
    if (r.icona) { disegnaIcona(pg, xc + 2.1, y + H_RIGA_LEG / 2 - 0.1, 3.9); xc += wIcona; }
    pg.testo(r.b, xc, yb, 'B', PT);
    pg.testo(r.t, xc + lMM(r.b, 'B', PT), yb, 'H', PT);
    y += H_RIGA_LEG;
  }
  y += 3;

  // ---------------------------------------------------------------- tabella
  const yT0 = y;
  const xs = (j) => xL + nomeW + j * s;                       // bordo sinistro della colonna j (0-based)
  const yBlocco = (i) => yT0 + 2 * hh + gap + i * (2 * s + gap);   // bordo alto del blocco dell'operatore i
  const yFine = yBlocco(n - 1) + 2 * s;

  // 1. sfondi dell'intestazione (le domeniche gialle; spesa arancio; collettivo azzurro)
  cols.forEach((c, j) => {
    const a = c.sun ? COLORI.giallo : c.coll ? COLORI.azzurro : null;
    if (a) pg.fill(xs(j), yT0, s, hh, a);
    const b = c.spesa ? COLORI.arancio : c.sun ? COLORI.giallo : c.coll ? COLORI.azzurro : null;
    if (b) pg.fill(xs(j), yT0 + hh, s, hh, b);
    if (c.coll) for (let i = 0; i < n; i++) pg.fill(xs(j), yBlocco(i), s, 2 * s, COLORI.azzurro);
  });

  // 2. testo dell'intestazione
  pg.testo('Operatore', xL + 1.6, yT0 + hh + 0.36 * (0.42 * s * MM) / MM, 'B', 0.42 * s * MM);
  cols.forEach((c, j) => {
    const cx = xs(j) + s / 2;
    pg.testoCentro(LETTERE[c.dow], cx, yT0 + hh / 2, 'B', 0.40 * s * MM);
    pg.testoCentro(c.extra ? `${pad(c.dd)}/${pad(c.mm)}` : String(c.d), cx, yT0 + hh * 1.5, 'B', (c.extra ? 0.30 : 0.40) * s * MM);
  });

  // 3. contenuto delle caselle
  const ptLett = 0.44 * s * MM, ptSub = 0.29 * s * MM, ptBig = 0.95 * s * MM;
  const merged = new Set();                                    // "i|j" = casella unica su due righe

  persone.forEach((p, i) => {
    const yM = yBlocco(i), yP = yM + s;
    pg.testo(p.name.toUpperCase(), xL + 1.6, yM + s + 0.36 * (0.42 * s * MM) / MM, 'B', 0.42 * s * MM);
    cols.forEach((c, j) => {
      const kinds = get(p.id, c.data);
      const has = (x) => kinds.find((e) => e.kind === x);
      const prevIso = new Date(Date.UTC(c.yy, c.mm - 1, c.dd - 1)).toISOString().slice(0, 10);
      const notteFinisce = get(p.id, prevIso).some((e) => e.kind === 'N');
      const notteInizia = has('N');
      const full = FULL_DAY.map(has).find(Boolean);
      const x0 = xs(j), cx = x0 + s / 2;

      if (full && !notteFinisce && !notteInizia) {
        merged.add(`${i}|${j}`);
        const cy = yM + s;                                     // centro della casella doppia
        if (full.kind === 'F') pg.testoCentro('F', cx, cy, 'H', ptBig);
        else if (full.kind === 'R') pg.testoCentro('R', cx, cy, 'H', ptBig);
        else if (full.kind === 'RR' || full.kind === 'PERM') {      // lettera grande + R maiuscola piccola a pedice
          const L = full.kind === 'RR' ? 'R' : 'P';
          const wR = lMM(L, 'H', ptBig), wS = lMM('R', 'B', ptSub);
          const xa = cx - (wR + 0.2 + wS) / 2;
          pg.testo(L, xa, cy + 0.36 * ptBig / MM, 'H', ptBig);
          pg.testo('R', xa + wR + 0.2, cy + 0.36 * ptBig / MM + 0.1 * s, 'B', ptSub);
        } else if (full.kind === 'FS') pg.linea(cx - 0.17 * s, cy, cx + 0.17 * s, cy, 0.5);
        return;
      }

      // riga alta (mattina): M, eventuale R piccola, copertura spesa, RB
      const cyM = yM + s / 2;
      const parti = [];
      if (has('M')) { parti.push({ t: 'M', f: 'B', pt: ptLett }); if (has('M').requested) parti.push({ t: 'R', f: 'B', pt: ptSub, giu: true }); }
      if (has('SPESA')) parti.push({ icona: true, d: 0.575 * s });
      if (has('RB')) parti.push({ t: 'RB', f: 'B', pt: 0.33 * s * MM });
      disegnaGruppo(pg, parti, cx, cyM, s);

      // riga bassa (pomeriggio)
      const cyP = yP + s / 2;
      const bassa = [];
      if (has('P')) { bassa.push({ t: 'P', f: 'B', pt: ptLett }); if (has('P').requested) bassa.push({ t: 'R', f: 'B', pt: ptSub, giu: true }); }
      if (full) bassa.push({ t: { F: 'F', FS: '–', PERM: 'P', R: 'R', RR: 'R' }[full.kind], f: 'H', pt: ptLett });
      disegnaGruppo(pg, bassa, cx, cyP, s);
      if (notteInizia && notteInizia.requested) {
        pg.testo('R', x0 + s - 0.12 * s - lMM('R', 'B', ptSub), yP + s - 0.14 * s, 'B', ptSub);
      }

      // sbarra della notte: da in basso a sinistra (pomeriggio del giorno N) a in alto a destra (mattina di N+1)
      if (notteInizia) pg.linea(x0, yP + s, x0 + s, yP, 0.38);
      if (notteFinisce) pg.linea(x0, yM + s, x0 + s, yM, 0.38);
    });
  });

  // 4. linee sottili
  const topBlocchi = [...Array(n).keys()].map(yBlocco);
  // intestazione: riquadro "Operatore", tre orizzontali, verticali tra i giorni
  pg.rettangolo(xL, yT0, nomeW, 2 * hh, SOTTILE);
  [0, hh, 2 * hh].forEach((o) => pg.linea(xs(0), yT0 + o, xR, yT0 + o));
  for (let j = 0; j <= nCol; j++) pg.linea(xs(j), yT0, xs(j), yT0 + 2 * hh);
  for (let i = 0; i < n; i++) {
    const yM = topBlocchi[i], yP = yM + s;
    for (let j = 0; j < nCol; j++) if (!merged.has(`${i}|${j}`)) pg.linea(xs(j), yP, xs(j + 1), yP);
    for (let j = 0; j <= nCol; j++) pg.linea(xs(j), yM, xs(j), yM + 2 * s);
    pg.linea(xL, yM, xL, yM + 2 * s);
  }

  // 5. linee marcate: sopra e sotto ogni operatore, bordo sinistro dei nomi, fine settimana e fine mese
  for (let i = 0; i < n; i++) {
    const yM = topBlocchi[i];
    pg.linea(xL, yM, xR, yM, FORTE, { cap: 2 });
    pg.linea(xL, yM + 2 * s, xR, yM + 2 * s, FORTE, { cap: 2 });
    pg.linea(xL, yM, xL, yM + 2 * s, FORTE, { cap: 2 });
  }
  cols.forEach((c, j) => { if (c.wk) pg.linea(xs(j + 1), yT0, xs(j + 1), yFine, FORTE, { cap: 2 }); });   // dopo ogni domenica e dopo l'ultima colonna
  pg.linea(xs(nCol - 1), yT0, xs(nCol - 1), yFine, FORTE, { cap: 2 });                                      // prima della colonna del 1° mese dopo

  // ---------------------------------------------------------------- osservazioni
  let yO = yFine + 5;
  pg.testo('Osservazioni:', xL + 1, yO + 1.2, 'B', PT_OSS);
  const xO = xL + 1 + lMM('Osservazioni: ', 'B', PT_OSS);
  lineeOss.forEach((riga, k) => {
    const yb = yO + 1.2 + k * H_OSS_RIGA;
    const xa = k === 0 ? xO : xL + 1;
    pg.linea(xa, yb + 0.9, xR - 1, yb + 0.9, 0.22, { hex: '#555555', tratteggio: [0.25, 0.7], cap: 1 });
    pg.testo(riga, xa + 2, yb, 'B', PT_OSS);
  });

  return costruisciPdf(pg, `Turni ${nomeMese(month)} ${year}`, logo);
}

// ----------------------------------------------------------------- pezzi di disegno
// icona "copertura spesa": cerchio con una stella a sei raggi
function disegnaIcona(pg, cx, cy, d) {
  const k = d / 20;
  pg.cerchio(cx, cy, 8.2 * k, 1.3 * k);
  const w = 1.5 * k;
  pg.linea(cx, cy - 5.4 * k, cx, cy + 5.4 * k, w, { cap: 1 });
  pg.linea(cx - 4.7 * k, cy - 2.7 * k, cx + 4.7 * k, cy + 2.7 * k, w, { cap: 1 });
  pg.linea(cx + 4.7 * k, cy - 2.7 * k, cx - 4.7 * k, cy + 2.7 * k, w, { cap: 1 });
}

// disegna in fila (centrata nella casella) lettere, R piccole a pedice e icone
function disegnaGruppo(pg, parti, cx, cy, s) {
  if (!parti.length) return;
  const lung = (p) => (p.icona ? p.d : lMM(p.t, p.f, p.pt));
  const spazio = 0.03 * s;
  const tot = parti.reduce((a, p) => a + lung(p), 0) + spazio * (parti.length - 1);
  const rif = parti.find((p) => !p.icona && !p.giu);          // corpo di riferimento per la linea di base
  let x = cx - tot / 2;
  for (const p of parti) {
    if (p.icona) disegnaIcona(pg, x + p.d / 2, cy, p.d);
    else if (p.giu) pg.testo(p.t, x, cy + 0.36 * (rif ? rif.pt : p.pt) / MM + 0.1 * s, p.f, p.pt);   // R piccola in basso
    else pg.testo(p.t, x, cy + 0.36 * p.pt / MM, p.f, p.pt);
    x += lung(p) + spazio;
  }
}
