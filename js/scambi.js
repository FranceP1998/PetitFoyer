// Cambi turno tra operatori: le stesse regole del database, per la modalità demo e per mostrare i testi.
// Un cambio è sempre uno scambio con restituzione: A cede il turno del giorno d1, B cede il turno del giorno d2.
export const MAX_SCAMBI = 4;
export const TURNI = ['M', 'P', 'N'];
export const NOME_TURNO = { M: 'mattina', P: 'pomeriggio', N: 'notte' };
export const ORARIO_TURNO = { M: '7-15', P: '15-23', N: '23-7' };

const piu = (data, n) => { const x = new Date(`${data}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const gm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const descrTurno = (kind, data) => `${kind === 'M' ? 'la mattina' : kind === 'P' ? 'il pomeriggio' : 'la notte'} del ${gm(data)}`;
export const meseDi = (data) => data.slice(0, 7);

const kindLavoro = (sh, o, d) => sh.find((s) => s.staff_id === o && s.date === d && TURNI.includes(s.kind))?.kind || null;
const occupato = (sh, o, d) => !!(kindLavoro(sh, o, d) || kindLavoro(sh, o, piu(d, -1)) === 'N' || sh.some((s) => s.staff_id === o && s.date === d && s.kind === 'T1018'));

// Regole non rispettate attorno a un periodo (solo per avvisare)
export function avvisiPersona(sh, o, da, a) {
  const out = [];
  for (let x = piu(da, -6); x <= piu(a, 6); x = piu(x, 1)) {
    const k = kindLavoro(sh, o, x), k1 = kindLavoro(sh, o, piu(x, 1)), k2 = kindLavoro(sh, o, piu(x, 2));
    if (k === 'P' && k1 === 'M') out.push(`mattina dopo un pomeriggio il ${gm(piu(x, 1))} (meno di 11 ore)`);
    if (k === 'N') {
      if (k1 === 'M' || k1 === 'P') out.push(`turno subito dopo la notte il ${gm(piu(x, 1))}`);
      if (k1 !== 'N' && k2) out.push(`turno nel giorno di riposo dopo la notte il ${gm(piu(x, 2))}`);
      if (k1 === 'N' && k2 === 'N' && kindLavoro(sh, o, piu(x, -1)) !== 'N') out.push(`più di due notti di fila dal ${gm(x)}`);
    }
    if (occupato(sh, o, x) && !occupato(sh, o, piu(x, -1))) {
      let n = 1; while (occupato(sh, o, piu(x, n))) n++;
      if (n > 4) out.push(`più di 4 giorni di fila dal ${gm(x)}`);
    }
  }
  return out;
}

const PRINCIPALI = ['M', 'P', 'N', 'R', 'RR', 'F', 'FS', 'PERM', 'T1018', 'MU'];
// Riposo obbligato (R) dopo l'ultima notte di una serie, ricalcolato attorno a un periodo. Restituisce le righe aggiornate.
function ricalcolaRiposi(sh, o, da, a, nuovoId) {
  let out = sh.filter((s) => !(s.staff_id === o && s.kind === 'R' && !s.requested && s.date >= piu(da, -1) && s.date <= piu(a, 3)
    && !(kindLavoro(sh, o, piu(s.date, -2)) === 'N' && kindLavoro(sh, o, piu(s.date, -1)) !== 'N')));
  for (let d = piu(da, -3); d <= piu(a, 1); d = piu(d, 1)) {
    if (kindLavoro(out, o, d) === 'N' && kindLavoro(out, o, piu(d, 1)) !== 'N') {
      const x = piu(d, 2);
      if (!out.some((s) => s.staff_id === o && s.date === x && PRINCIPALI.includes(s.kind))) out.push({ id: nuovoId(), staff_id: o, date: x, kind: 'R', requested: false, start_time: null, end_time: null });
    }
  }
  return out;
}

// Sposta i due turni (e ricalcola i riposi obbligati dei due). Restituisce il nuovo elenco di righe.
export function applicaScambio(sh, a, b, d1, d2, nuovoId) {
  const ra = sh.find((s) => s.staff_id === a && s.date === d1 && TURNI.includes(s.kind));
  const rb = sh.find((s) => s.staff_id === b && s.date === d2 && TURNI.includes(s.kind));
  let out = sh.filter((s) => s !== ra && s !== rb
    && !(s.staff_id === b && s.date === d1 && s.kind === 'R' && !s.requested)
    && !(s.staff_id === a && s.date === d2 && s.kind === 'R' && !s.requested));
  out.push({ id: nuovoId(), staff_id: b, date: d1, kind: ra.kind, requested: false, festivo: !!ra.festivo, start_time: null, end_time: null });
  out.push({ id: nuovoId(), staff_id: a, date: d2, kind: rb.kind, requested: false, festivo: !!rb.festivo, start_time: null, end_time: null });
  const da = d1 < d2 ? d1 : d2, aa = d1 < d2 ? d2 : d1;
  out = ricalcolaRiposi(out, a, da, aa, nuovoId);
  out = ricalcolaRiposi(out, b, da, aa, nuovoId);
  return out;
}

// Avvisi nuovi che il cambio crea (prima e dopo, senza modificare niente)
export function avvisiScambio(sh, staff, a, b, d1, d2) {
  const nome = (id) => staff.find((p) => p.id === id)?.name || '';
  const da = d1 < d2 ? d1 : d2, aa = d1 < d2 ? d2 : d1;
  const tutti = (x) => [...avvisiPersona(x, a, da, aa).map((t) => `${nome(a)}: ${t}`), ...avvisiPersona(x, b, da, aa).map((t) => `${nome(b)}: ${t}`)];
  const prima = tutti(sh);
  let id = -1;
  const dopo = tutti(applicaScambio(sh, a, b, d1, d2, () => id--));
  return dopo.filter((t) => !prima.includes(t));
}

// Controlli che BLOCCANO un cambio (le altre regole si possono saltare). Restituisce i due turni.
export function validaScambio({ shifts, staff, scambi, oggi, pubblicato }, a, b, d1, d2, escludi = null) {
  const err = (m) => { throw new Error(m); };
  const nome = (id) => staff.find((p) => p.id === id)?.name || '';
  if (!a || !b || a === b) err('Scegli un collega.');
  if (staff.filter((p) => [a, b].includes(p.id) && p.role === 'operator' && p.active !== false).length !== 2) err('Il cambio è possibile solo tra operatori in servizio.');
  if (!d1 || !d2) err('Scegli i due turni.');
  if (d1 < oggi || d2 < oggi) err('Si possono cambiare solo turni da oggi in poi.');
  if (!pubblicato(d1) || !pubblicato(d2)) err('Si possono cambiare solo turni di mesi già pubblicati.');
  const k1 = kindLavoro(shifts, a, d1), k2 = kindLavoro(shifts, b, d2);
  if (!k1) err(`${nome(a)} non ha un turno il ${gm(d1)}.`);
  if (!k2) err(`${nome(b)} non ha un turno il ${gm(d2)}.`);
  if (d1 === d2 && k1 === k2) err('Sono lo stesso turno.');
  if (shifts.some((s) => ((s.staff_id === a && s.date === d1) || (s.staff_id === b && s.date === d2)) && (s.kind === 'MU' || (TURNI.includes(s.kind) && (s.start_time || s.end_time))))) err('Quel turno ha una malattia o un orario particolare: non si può cambiare dall\'app. Parlane con Marie.');
  const occupata = (o, d) => shifts.some((s) => s.staff_id === o && s.date === d && (['RR', 'F', 'FS', 'PERM', 'T1018', 'MU'].includes(s.kind) || (TURNI.includes(s.kind) && d1 !== d2)));
  if (occupata(a, d2)) err(`${nome(a)} ha già un turno, ferie, permesso o riposo richiesto il ${gm(d2)}.`);
  if (occupata(b, d1)) err(`${nome(b)} ha già un turno, ferie, permesso o riposo richiesto il ${gm(d1)}.`);
  const attivi = (scambi || []).filter((w) => w.status === 'pending' && w.id !== escludi);
  if (attivi.some((w) => (w.from_staff === a && w.date_from === d1) || (w.to_staff === a && w.date_to === d1) || (w.from_staff === b && w.date_from === d2) || (w.to_staff === b && w.date_to === d2))) err('C\'è già un cambio in attesa su uno di quei turni.');
  for (const o of [a, b]) for (const m of new Set([meseDi(d1), meseDi(d2)])) {
    const n = (scambi || []).filter((w) => w.status === 'accepted' && (w.from_staff === o || w.to_staff === o) && (meseDi(w.date_from) === m || meseDi(w.date_to) === m)).length;
    if (n >= MAX_SCAMBI) err(`${nome(o)} ha già fatto ${MAX_SCAMBI} cambi turno questo mese.`);
  }
  return { k1, k2 };
}
