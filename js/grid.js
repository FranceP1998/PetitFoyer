import { descriviCella, notteFinisceDa, muDaIeri, deltaFineNotte, scostamento, inServizio } from './cella.js';

// Disegna il foglio turni come tabella HTML (stesso schema del foglio cartaceo):
// due righe per persona (M sopra, P sotto), giorni in orizzontale, ultima colonna = 1° del mese dopo.

const LETTERE = ['D', 'L', 'M', 'M', 'G', 'V', 'S'];          // getDay(): 0 = domenica
const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
// Voci protette: la coordinatrice non può modificarle né cancellarle senza il consenso dell'operatore
export const PROTETTI = ['F', 'FS', 'PERM', 'RR'];
export const eProtetta = (e) => PROTETTI.includes(e.kind) || !!e.requested;              // occupano la cella su due righe

export const nomeMese = (m) => MESI[m - 1];
export const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICONA_SPESA =
  '<svg class="spesa" viewBox="0 0 20 20" aria-label="Copertura spesa"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 4.6v10.8M5.3 7.3l9.4 5.4M14.7 7.3l-9.4 5.4"/></g></svg>';

const SUB_R = '<sub class="req">R</sub>';
const parteHtml = (p) => ({
  lett: `<span class="lett">${p.v}</span>`,
  pedice: SUB_R,
  spesa: ICONA_SPESA,
  rb: '<span class="rb">RB</span>',
  piccola: `<span class="lett piccola">${p.v}</span>`,
  pillola: `<span class="pill">${esc(p.v)}</span>`,
  mu: '<span class="lett mu2">MU</span>',
  musub: `<sub class="req musub">${esc(p.v)}</sub>`,
}[p.t]);

export function giorniDelMese(y, m) { return new Date(y, m, 0).getDate(); }

// Giorno successivo all'ultimo del mese: { y, m, d:1 }
export function meseDopo(y, m) { return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; }

function indicizza(shifts) {
  const map = new Map();            // "staffId|data" -> [{kind, requested}]
  for (const s of shifts) {
    const k = `${s.staff_id}|${s.date}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ kind: s.kind, requested: !!s.requested, start_time: s.start_time || null, end_time: s.end_time || null });
  }
  return map;
}

// Righe di legenda in testa al foglio, ricavate dagli eventi del mese
export function righeLegenda(events, y, m, shifts = []) {
  const out = [];
  const ora = (t) => (t ? t.slice(0, 5).replace(':', '.') : '');
  const gg = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const delMese = events.filter((e) => e.date.startsWith(`${y}-${pad(m)}-`));
  // ogni riga ha l'html per lo schermo e le parti (b = grassetto, t = testo) per il PDF
  for (const e of delMese.filter((e) => e.kind === 'collettivo')) {
    const t = ` ${gg(e.date)}${e.start_time ? ' h ' + ora(e.start_time) : ''}${e.label ? ' ' + e.label : ''}`;
    out.push({ cls: 'collettivo', b: 'COLLETTIVO:', t, html: `<b>COLLETTIVO:</b>${esc(t)}` });
  }
  const spese = delMese.filter((e) => e.kind === 'spesa').sort((a, b) => a.date.localeCompare(b.date));
  if (spese.length) {
    const orario = spese[0].start_time && spese[0].end_time ? ` ${ora(spese[0].start_time)}–${ora(spese[0].end_time)}` : '';
    const giorni = spese.map((e) => gg(e.date)).join(' – ');
    out.push({ cls: 'spesa', icona: true, b: 'COPERTURA SPESA:', t: ` ${giorni}${orario ? ' ore' + orario : ''}`,
      html: `${ICONA_SPESA} <b>COPERTURA SPESA:</b> ${giorni}${orario ? ' →' + orario : ''}` });
  }
  for (const e of delMese.filter((e) => e.kind === 'altro')) {
    const t = `${gg(e.date)} ${e.label}`;
    out.push({ cls: 'altro', b: '', t, html: esc(t) });
  }
  // la spiegazione di RB compare solo se nel mese c'è almeno un recupero ore
  if (shifts.some((s) => s.kind === 'RB' && s.date.startsWith(`${y}-${pad(m)}-`))) {
    out.push({ cls: 'rbleg', b: 'RB', t: ' – recupero ore', html: '<b>RB</b> – recupero ore' });
  }
  const delMeseTurni = shifts.filter((s) => s.date.startsWith(`${y}-${pad(m)}-`));
  if (delMeseTurni.some((s) => s.kind === 'MU')) {
    out.push({ cls: 'mugleg', b: 'MU', t: ' – malattia: a pedice il turno saltato (M mattina, P pomeriggio, / notte)', html: '<b>MU</b> – malattia: a pedice il turno saltato (M mattina, P pomeriggio, / notte)' });
  }
  if (delMeseTurni.some((s) => scostamento(s))) {
    out.push({ cls: 'deltaleg', b: '+4  /  −1', t: ' – ore in più o in meno: a sinistra all\'inizio del turno, a destra alla fine', html: '<b>+4 / −1</b> – ore in più o in meno: a sinistra all\'inizio del turno, a destra alla fine' });
  }
  return out;
}

export function renderGrid({ year, month, staff, shifts, events, righeVuote = 0, editable = false, evidenzia = null }) {
  const nGiorni = giorniDelMese(year, month);
  const next = meseDopo(year, month);
  const idx = indicizza(shifts);
  const get = (sid, data) => idx.get(`${sid}|${data}`) || [];
  const ev = (data) => events.filter((e) => e.date === data);

  // colonne: 1..nGiorni + colonna extra (1° del mese dopo)
  const cols = [];
  for (let d = 1; d <= nGiorni + 1; d++) {
    const extra = d === nGiorni + 1;
    const yy = extra ? next.y : year, mm = extra ? next.m : month, dd = extra ? 1 : d;
    const data = iso(yy, mm, dd);
    const dow = new Date(yy, mm - 1, dd).getDay();
    const eventi = ev(data);
    cols.push({
      d, extra, data, dow, dd, mm, yy,
      sun: dow === 0,
      weekEnd: dow === 0 || extra,
      collettivo: eventi.some((e) => e.kind === 'collettivo'),
      spesa: eventi.some((e) => e.kind === 'spesa'),
      altro: eventi.some((e) => e.kind === 'altro'),
    });
  }
  const classiCol = (c) =>
    [c.sun ? 'sun' : '', c.weekEnd ? 'wk' : '', c.extra ? 'extra' : '', c.collettivo ? 'ev-coll' : ''].filter(Boolean).join(' ');

  const ordinati = [...staff].filter((s) => inServizio(s, year, month)).sort((a, b) => a.sort_order - b.sort_order);

  // ---------- intestazione ----------
  let html = `<table class="foglio" style="width:calc(var(--nome) + ${cols.length} * var(--s))"><colgroup><col class="c-nome">`;
  for (let i = 0; i < cols.length; i++) html += '<col class="c-giorno">';
  html += '</colgroup><thead><tr class="h-lettere"><th class="nome-th" rowspan="2">Operatore</th>';
  for (const c of cols) html += `<th class="${classiCol(c)}">${LETTERE[c.dow]}</th>`;
  html += '</tr><tr class="h-numeri">';
  for (const c of cols) {
    const cls = [classiCol(c), c.spesa ? 'ev-spesa' : '', c.altro ? 'ev-altro' : ''].filter(Boolean).join(' ');
    html += `<th class="${cls}">${c.extra ? `${pad(c.dd)}/${pad(c.mm)}` : c.d}</th>`;
  }
  html += '</tr></thead><tbody>';

  // ---------- righe persone ----------
  const riga = (p) => {
    const nome = p ? esc(p.name.toUpperCase()) : '';
    const mio = p && evidenzia && p.id === evidenzia ? ' mia' : '';
    let rM = `<tr class="riga-m${mio}"><th class="nome" rowspan="2"><span>${nome}</span></th>`;
    let rP = `<tr class="riga-p${mio}">`;
    for (const c of cols) {
      const k = classiCol(c);
      const cella = (riga, contenuto, extraCls = '', rowspan = 1) => {
        const attrs = (p && editable ? ` data-staff="${p.id}" data-date="${c.data}"` : '') + (p ? ` data-p="${p.id}" data-d="${c.data}"` : '');
        return `<td class="${k} ${extraCls}"${rowspan > 1 ? ' rowspan="2"' : ''}${attrs}>${contenuto}</td>`;
      };
      if (!p) { rM += cella('m', ''); rP += cella('p', ''); continue; }

      const kinds = get(p.id, c.data);
      // notte che finisce stamattina (iniziata il giorno prima)
      const prevIso = new Date(Date.UTC(c.yy, c.mm - 1, c.dd - 1)).toISOString().slice(0, 10);
      const notteFinisce = notteFinisceDa(get(p.id, prevIso));
      const d = descriviCella(kinds, notteFinisce, muDaIeri(get(p.id, prevIso)), deltaFineNotte(get(p.id, prevIso)));
      const protCls = editable && kinds.some(eProtetta) ? ' prot' : '';

      if (d.doppia) {
        const g = d.grande;
        let txt = g.ovale
          ? `<span class="ovale${Math.max(g.ovale.alto.length, g.ovale.basso.length) > 2 ? ' lungo' : ''}"><b>${esc(g.ovale.alto)}</b><b>${esc(g.ovale.basso)}</b></span>`
          : g.trattino ? '<span class="trattino">–</span>'
          : g.mu ? '<span class="mu">MU</span>'
          : `<span class="big">${g.testo}</span>${g.pedice ? SUB_R : ''}`;
        txt += d.pillole.map((v) => `<span class="pill pill-basso">${esc(v)}</span>`).join('');
        rM += cella('m', txt, `full k-${d.kind}${protCls}`, 2);
        continue; // la riga P non emette nulla: la cella è su due righe
      }
      // ore in più/meno agli estremi del turno: a sinistra se si entra prima/dopo, a destra se si esce dopo/prima
      const lati = (l) => (l.s ? `<span class="dl">${l.s}</span>` : '') + (l.e ? `<span class="dr">${l.e}</span>` : '');
      rM += cella('m', d.alta.map(parteHtml).join('') + lati(d.latiAlta), (d.notteFinisce ? 'notte-fine' : '') + protCls);
      rP += cella('p', d.bassa.map(parteHtml).join('') + (d.notteIniziaRichiesta ? SUB_R : '') + lati(d.latiBassa), (d.notteInizia ? 'notte-inizia' : '') + protCls);
    }
    return rM + '</tr>' + rP + '</tr>';
  };

  // striscia bianca tra un operatore e l'altro: attraversata solo dalle linee verticali
  // di fine settimana e di fine mese, come nel foglio cartaceo
  const separatore = () => {
    let r = '<tr class="sep" aria-hidden="true"><td class="sep-nome"></td>';
    for (const c of cols) r += `<td class="${[c.weekEnd ? 'wk' : '', c.extra ? 'extra' : ''].filter(Boolean).join(' ')}"></td>`;
    return r + '</tr>';
  };
  const blocchi = [...ordinati, ...Array(righeVuote).fill(null)];
  html += separatore() + blocchi.map((p) => riga(p)).join(separatore());   // stessa striscia bianca anche tra l'intestazione e il primo operatore
  html += '</tbody></table>';
  return html;
}

// Sbarra della notte: una sola linea dritta dall'angolo in basso a sinistra della casella in cui la notte inizia
// all'angolo in alto a destra della casella in cui finisce. Si traccia sopra la tabella misurando le caselle vere,
// così combacia al pixel anche con bordi di spessore diverso.
export function tracciaNotti(contenitore) {
  contenitore.querySelector('svg.notti')?.remove();
  const tabella = contenitore.querySelector('table.foglio');
  if (!tabella) return;
  const base = contenitore.getBoundingClientRect();
  const fini = new Map();
  for (const td of tabella.querySelectorAll('td.notte-fine[data-p]')) fini.set(`${td.dataset.p}|${td.dataset.d}`, td);
  const linee = [];
  const pt = (x, y) => `${(x - base.left).toFixed(2)},${(y - base.top).toFixed(2)}`;
  const usate = new Set();
  for (const td of tabella.querySelectorAll('td.notte-inizia[data-p]')) {
    const a = td.getBoundingClientRect();
    const dopo = new Date(`${td.dataset.d}T12:00:00Z`); dopo.setUTCDate(dopo.getUTCDate() + 1);
    const chiave = `${td.dataset.p}|${dopo.toISOString().slice(0, 10)}`;
    const fine = fini.get(chiave);
    if (fine) {
      const b = fine.getBoundingClientRect();
      linee.push(`${pt(a.left, a.bottom)} ${pt(b.right, b.top)}`);
      usate.add(chiave);
    } else linee.push(`${pt(a.left, a.bottom)} ${pt(a.right, a.top)}`);        // la notte finisce fuori dal foglio
  }
  for (const [chiave, td] of fini) if (!usate.has(chiave)) { const b = td.getBoundingClientRect(); linee.push(`${pt(b.left, b.bottom)} ${pt(b.right, b.top)}`); }   // la notte è iniziata nel mese prima
  const w = tabella.offsetWidth, h = tabella.offsetHeight;
  const svg = `<svg class="notti" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${linee.map((l) => `<polyline points="${l}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="butt"/>`).join('')}</svg>`;
  contenitore.insertAdjacentHTML('beforeend', svg);
}
