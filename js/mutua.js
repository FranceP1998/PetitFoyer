// Copertura di un'assenza per malattia: chi fa il turno PRIMA resta 4 ore in più, chi fa il turno DOPO
// entra 4 ore prima, così le 8 ore del turno scoperto sono coperte.
import { STANDARD, aggiungiOre } from './cella.js';

const giornoDopo = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const orari = (e) => { const [a, b] = STANDARD[e.kind]; return [String(e.start_time || a).slice(0, 5), String(e.end_time || b).slice(0, 5)]; };

// per ogni turno: quale turno viene prima e quale dopo, e in che giorno
const VICINI = {
  M: { prima: ['N', -1], dopo: ['P', 0] },     // prima c'è la notte iniziata ieri, dopo il pomeriggio
  P: { prima: ['M', 0], dopo: ['N', 0] },
  N: { prima: ['P', 0], dopo: ['M', 1] },      // dopo c'è la mattina di domani
};

// shifts: tutti i turni caricati; staff: elenco persone. turno = M, P o N del malato in quel giorno.
export function proponiCopertura({ shifts, staff, staffId, date, turno, ore = 4 }) {
  const nome = (id) => staff.find((p) => p.id === id)?.name || '?';
  const inMalattia = (s) => shifts.some((x) => x.staff_id === s.staff_id && x.date === s.date && x.kind === 'MU');
  const trova = (kind, data) => shifts.find((s) => s.date === data && s.kind === kind && s.staff_id !== staffId && !inMalattia(s)) || null;
  const v = VICINI[turno];
  const out = { prima: null, dopo: null, ore };
  const pr = trova(v.prima[0], giornoDopo(date, v.prima[1]));
  if (pr) { const [a, b] = orari(pr); out.prima = { staffId: pr.staff_id, nome: nome(pr.staff_id), date: pr.date, kind: pr.kind, inizio: a, fine: aggiungiOre(b, ore) }; }
  const dp = trova(v.dopo[0], giornoDopo(date, v.dopo[1]));
  if (dp) { const [a, b] = orari(dp); out.dopo = { staffId: dp.staff_id, nome: nome(dp.staff_id), date: dp.date, kind: dp.kind, inizio: aggiungiOre(a, -ore), fine: b }; }
  return out;
}

// Quali giorni diventano MU quando un operatore comunica la malattia (stessa regola del database):
// giorni con un'attività (M, P, N, 10-18, copertura, spesa, recupero ore), senza riposi/ferie/permessi, non già in malattia.
// Per le notti conta il giorno in cui la notte INIZIA. Restituisce [{date, kind}] dove kind = turno saltato.
export const ATTIVITA = ['M', 'P', 'N', 'T1018', 'COP', 'SPESA', 'RB'];
export function giorniMalattia(shifts, staffId, da, a) {
  const perGiorno = new Map();
  for (const s of shifts) {
    if (s.staff_id !== staffId || s.date < da || s.date > a) continue;
    if (!perGiorno.has(s.date)) perGiorno.set(s.date, new Set());
    perGiorno.get(s.date).add(s.kind);
  }
  const out = [];
  for (const [date, kinds] of [...perGiorno].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (['R', 'RR', 'F', 'FS', 'PERM', 'MU'].some((k) => kinds.has(k))) continue;
    const saltato = ATTIVITA.find((k) => kinds.has(k));
    if (saltato) out.push({ date, kind: saltato });
  }
  return out;
}
