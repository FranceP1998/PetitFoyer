// Descrive in modo neutro che cosa va disegnato in una casella-giorno di un operatore.
// La usano sia il foglio a schermo (grid.js) sia il PDF (pdf.js), così i due restano identici.
//
// Ingresso: kinds = [{kind, requested, start_time, end_time}] di quel giorno, e se la notte
// del giorno prima finisce stamattina. Uscita:
//   { doppia: true,  grande, pillole }        casella unica su due righe (ferie, riposo, 10-18...)
//   { doppia: false, alta, bassa, notteInizia, notteIniziaRichiesta, notteFinisce }

export const FULL_DAY = ['MU', 'PERM', 'F', 'FS', 'RR', 'R'];       // occupano tutto il giorno (MU = malattia)

// orari standard dei turni
export const STANDARD = { M: ['07:00', '15:00'], P: ['15:00', '23:00'], N: ['23:00', '07:00'] };

const minuti = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };
export function aggiungiOre(t, ore) {                                   // '15:00' + 4 -> '19:00'  (oltre la mezzanotte si ricomincia)
  const m = (((minuti(t) + Math.round(ore * 60)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ore in più (+) o in meno (-) di un turno M/P/N rispetto alle 8 standard, se ha orari modificati
export function scostamento(e) {
  if (!STANDARD[e.kind] || !e.start_time || !e.end_time) return 0;
  const [a, b] = STANDARD[e.kind];
  if (String(e.start_time).slice(0, 5) === a && String(e.end_time).slice(0, 5) === b) return 0;
  let d = minuti(e.end_time) - minuti(e.start_time);
  if (d <= 0) d += 1440;
  return (d - 480) / 60;
}
// ore in più/meno AGLI ESTREMI del turno: s = all'inizio (+ se si entra prima), e = alla fine (+ se si esce dopo)
const diffMin = (x) => (((x + 720) % 1440) + 1440) % 1440 - 720;
export function latiOrari(e) {
  if (!STANDARD[e?.kind] || !e.start_time || !e.end_time) return { s: 0, e: 0 };
  const [a, b] = STANDARD[e.kind];
  return { s: diffMin(minuti(a) - minuti(e.start_time)) / 60, e: diffMin(minuti(e.end_time) - minuti(b)) / 60 };
}
export const etichettaScostamento = (h) => `${h > 0 ? '+' : '−'}${String(Math.abs(h)).replace('.', ',')}`;

// questa notte (iniziata il giorno prima) finisce stamattina? (non se chi la faceva è in malattia)
export const notteFinisceDa = (kindsIeri) => kindsIeri.some((e) => e.kind === 'N') && !kindsIeri.some((e) => e.kind === 'MU');

// la notte iniziata ieri era una notte saltata per malattia? (stamattina compare "MU" col pedice della notte)
export const muDaIeri = (kindsIeri) => kindsIeri.some((e) => e.kind === 'N') && kindsIeri.some((e) => e.kind === 'MU');

// ore in più/meno alla FINE di una notte (iniziata ieri): si scrive stamattina, a destra, dove la notte finisce
export function deltaFineNotte(kindsIeri) {
  const n = kindsIeri.find((e) => e.kind === 'N');
  if (!n || kindsIeri.some((e) => e.kind === 'MU')) return '';
  const h = latiOrari(n).e;
  return h ? etichettaScostamento(h) : '';
}

// '09:30:00' -> '9.30'    '10:00' -> '10'
export function oraBreve(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  return Number(m) ? `${Number(h)}.${m}` : String(Number(h));
}

// ore di durata di un turno con orari (per il conteggio del monte ore)
export function durataOre(inizio, fine) {
  if (!inizio || !fine) return 0;
  const min = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };
  let d = min(fine) - min(inizio);
  if (d <= 0) d += 24 * 60;
  return d / 60;
}

export function descriviCella(kinds, notteFinisce, muFine = false, fineDelta = '') {
  // in malattia il turno resta registrato ma non si disegna: al suo posto c'è "MU" con a pedice
  // il turno saltato (M, P oppure / per la notte), solo nello spazio che quel turno occupava
  let muTurno = null, muLibero = false;
  if (kinds.some((e) => e.kind === 'MU')) {
    muTurno = ['M', 'P', 'N'].find((k) => kinds.some((e) => e.kind === k)) || null;
    if (muTurno) kinds = kinds.filter((e) => !['M', 'P', 'N', 'MU'].includes(e.kind));
    else if (!kinds.some((e) => ['T1018', 'COP'].includes(e.kind)) && kinds.some((e) => ['SPESA', 'RB'].includes(e.kind))) {
      muLibero = true;                                             // malattia nel giorno di una copertura spesa o di un recupero: MU nella riga libera
      kinds = kinds.filter((e) => e.kind !== 'MU');
    }
    // con 10-18 o con una copertura la casella resta unica: MU grande e gli orari cerchiati sotto
  }
  const muOccupa = !!muTurno || muFine || muLibero;
  const mP = (v) => [{ t: 'mu' }, { t: 'musub', v }];
  const has = (x) => kinds.find((e) => e.kind === x);
  const notteInizia = has('N') || null;
  const full = FULL_DAY.map(has).find(Boolean) || null;
  const libera = !notteFinisce && !notteInizia && !muOccupa;

  // turni "in più" disegnati cerchiati: 10-18 (orario fisso) e copertura (orario scelto dalla coordinatrice)
  const ovali = [];
  if (has('T1018')) ovali.push({ alto: '10', basso: '18' });
  if (has('COP')) ovali.push({ alto: oraBreve(has('COP').start_time), basso: oraBreve(has('COP').end_time) });
  const testoOvale = (o) => `${o.alto}–${o.basso}`;
  const altri = !!full || kinds.some((e) => ['M', 'P', 'SPESA', 'RB'].includes(e.kind));

  // ---- casella unica su due righe
  if (full && libera) {
    const k = full.kind;
    const grande = k === 'FS' ? { trattino: true }
      : k === 'MU' ? { testo: 'MU', mu: true }
      : { testo: k === 'PERM' ? 'P' : k === 'F' ? 'F' : 'R', pedice: k === 'RR' || k === 'PERM' };
    return { doppia: true, kind: k, grande, pillole: ovali.map(testoOvale) };
  }
  if (libera && !altri && ovali.length === 1) {
    return { doppia: true, kind: 'OVALE', grande: { ovale: ovali[0] }, pillole: [] };
  }

  // ---- due righe separate
  const alta = [], bassa = [];
  const M = has('M'), P = has('P');
  const lab = (h) => (h ? etichettaScostamento(h) : '');
  const lati = (e) => { const l = latiOrari(e); return { s: lab(l.s), e: lab(l.e) }; };
  const latiAlta = M ? lati(M) : { s: '', e: '' };
  if (!M && notteFinisce && fineDelta) latiAlta.e = fineDelta;                 // fine notte: a destra, nella casella dove la notte finisce
  const latiBassa = P ? lati(P) : notteInizia ? { s: lati(notteInizia).s, e: '' } : { s: '', e: '' };   // inizio notte: a sinistra, dove la notte inizia
  if (M) { alta.push({ t: 'lett', v: 'M' }); if (M.requested) alta.push({ t: 'pedice' }); }
  if (muTurno === 'M') alta.push(...mP('M'));
  if (muFine) alta.push(...mP('/'));
  if (has('SPESA')) alta.push({ t: 'spesa' });
  if (has('RB')) alta.push({ t: 'rb' });
  if (P) { bassa.push({ t: 'lett', v: 'P' }); if (P.requested) bassa.push({ t: 'pedice' }); }
  if (muTurno === 'P') bassa.push(...mP('P'));
  if (muTurno === 'N') bassa.push(...mP('/'));
  if (muLibero) bassa.push({ t: 'mu' });
  if (full) bassa.push({ t: 'piccola', v: { F: 'F', FS: '–', PERM: 'P', R: 'R', RR: 'R', MU: 'MU' }[full.kind] });

  // le coperture/10-18 compatte finiscono nella prima riga libera
  let altaLibera = !M && !has('SPESA') && !has('RB') && !notteFinisce && muTurno !== 'M' && !muFine;
  let bassaLibera = !P && !full && !notteInizia && muTurno !== 'P' && muTurno !== 'N' && !muLibero;
  for (const o of ovali) {
    const pillola = { t: 'pillola', v: testoOvale(o) };
    if (altaLibera) { alta.push(pillola); altaLibera = false; }
    else if (bassaLibera) { bassa.push(pillola); bassaLibera = false; }
    else alta.push(pillola);
  }

  return {
    doppia: false, alta, bassa,
    notteInizia: !!notteInizia, notteIniziaRichiesta: !!(notteInizia && notteInizia.requested),
    latiAlta, latiBassa,
    notteFinisce: !!notteFinisce,
  };
}

// Una persona compare nel foglio del mese se in quel mese era in servizio
// (le date di inizio e fine servizio decidono: così i mesi passati restano com'erano).
export function inServizio(p, y, m) {
  const primo = `${y}-${String(m).padStart(2, '0')}-01`;
  const ultimo = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return (!p.start_date || p.start_date <= ultimo) && (!p.end_date || p.end_date >= primo);
}
