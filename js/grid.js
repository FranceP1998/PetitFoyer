// Disegna il foglio turni come tabella HTML (stesso schema del foglio cartaceo):
// due righe per persona (M sopra, P sotto), giorni in orizzontale, ultima colonna = 1° del mese dopo.

const LETTERE = ['D', 'L', 'M', 'M', 'G', 'V', 'S'];          // getDay(): 0 = domenica
const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const FULL_DAY = ['PERM', 'F', 'FS', 'RR', 'R'];
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

export function giorniDelMese(y, m) { return new Date(y, m, 0).getDate(); }

// Giorno successivo all'ultimo del mese: { y, m, d:1 }
export function meseDopo(y, m) { return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; }

function indicizza(shifts) {
  const map = new Map();            // "staffId|data" -> [{kind, requested}]
  for (const s of shifts) {
    const k = `${s.staff_id}|${s.date}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ kind: s.kind, requested: !!s.requested });
  }
  return map;
}

// Righe di legenda in testa al foglio, ricavate dagli eventi del mese
export function righeLegenda(events, y, m) {
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
  out.push({ cls: 'rbleg', b: 'RB', t: ' – recupero ore', html: '<b>RB</b> – recupero ore' });
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

  const ordinati = [...staff].filter((s) => s.active !== false).sort((a, b) => a.sort_order - b.sort_order);

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
        const attrs = p && editable ? ` data-staff="${p.id}" data-date="${c.data}"` : '';
        return `<td class="${k} ${extraCls}"${rowspan > 1 ? ' rowspan="2"' : ''}${attrs}>${contenuto}</td>`;
      };
      if (!p) { rM += cella('m', ''); rP += cella('p', ''); continue; }

      const kinds = get(p.id, c.data);
      const has = (x) => kinds.find((e) => e.kind === x);
      // notte che finisce stamattina (iniziata il giorno prima)
      const prev = new Date(Date.UTC(c.yy, c.mm - 1, c.dd - 1));
      const prevIso = prev.toISOString().slice(0, 10);
      const notteFinisce = get(p.id, prevIso).some((e) => e.kind === 'N');
      const notteInizia = has('N');
      const full = FULL_DAY.map(has).find(Boolean);
      const protCls = editable && kinds.some(eProtetta) ? ' prot' : '';

      if (full && !notteFinisce && !notteInizia) {
        const txt = {
          F: '<span class="big">F</span>',
          FS: '<span class="trattino">–</span>',
          PERM: `<span class="big">P</span>${SUB_R}`,   // permesso: P grande con R a pedice (è sempre una richiesta)
          R: '<span class="big">R</span>',
          RR: `<span class="big">R</span>${SUB_R}`,
        }[full.kind];
        rM += cella('m', txt, `full k-${full.kind}${protCls}`, 2);
        continue; // la riga P non emette nulla: la cella è su due righe
      }

      // riga alta (mattina)
      let m = '';
      if (has('M')) m += `<span class="lett">M</span>${has('M').requested ? SUB_R : ''}`;
      if (has('SPESA')) m += ICONA_SPESA;
      if (has('RB')) m += '<span class="rb">RB</span>';
      rM += cella('m', m, (notteFinisce ? 'notte-fine' : '') + protCls);

      // riga bassa (pomeriggio)
      let pp = '';
      if (has('P')) pp += `<span class="lett">P</span>${has('P').requested ? SUB_R : ''}`;
      if (notteInizia && notteInizia.requested) pp += SUB_R;
      if (full) pp += `<span class="lett piccola">${{ F: 'F', FS: '–', PERM: 'P', R: 'R', RR: 'R' }[full.kind]}</span>`;
      rP += cella('p', pp, (notteInizia ? 'notte-inizia' : '') + protCls);
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
