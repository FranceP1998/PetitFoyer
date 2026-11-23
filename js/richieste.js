// Regole delle richieste di riposo o di turno: stessa logica del database (supabase/schema.sql, sezione 16),
// usata solo dalla modalità demo. Nell'app vera le regole le applica il database.
const PRINCIPALI = ['M', 'P', 'N', 'R', 'RR', 'F', 'FS', 'PERM', 'T1018'];
const giorno = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const err = (t) => { throw new Error(t); };

// db = { shifts, richieste }; escludi = id di una richiesta da non contare.
// Se una regola BLOCCA solleva un errore; altrimenti restituisce l'elenco delle regole non rispettate
// (vuoto = richiesta regolare). Chi chiede comunque una richiesta "critica" lascia decidere a Marie.
export function controllaRegole(db, staffId, date, kind, escludi = null) {
  const tipo = (d) => db.shifts.find((s) => s.staff_id === staffId && s.date === d && PRINCIPALI.includes(s.kind))?.kind
    || (db.richieste || []).find((r) => r.staff_id === staffId && r.status === 'pending' && r.id !== escludi && d >= r.date && d <= (r.last_date || r.date))?.kind || null;
  if (tipo(date)) err('In quel giorno hai già un turno, un riposo o una richiesta.');
  const prima = tipo(giorno(date, -1)), dopo = tipo(giorno(date, 1));
  const estate = [6, 7, 8].includes(+date.slice(5, 7));
  const avvisi = [];
  if (prima === 'N' && kind !== 'N') avvisi.push('Il giorno dopo una notte è riposo obbligatorio.');
  const serie = (insieme, verso) => { let n = 0; while (insieme.includes(tipo(giorno(date, verso * (n + 1))))) n++; return n; };
  if (kind === 'N') {
    if (dopo && !['N', 'R', 'RR'].includes(dopo)) avvisi.push('Il giorno dopo una notte deve restare libero per il riposo.');
    if (serie(['N'], -1) + serie(['N'], 1) + 1 >= 3) avvisi.push('Più di due notti consecutive.');
  }
  if ((kind === 'M' && prima === 'P') || (kind === 'P' && dopo === 'M')) avvisi.push('Una mattina il giorno dopo un pomeriggio: restano meno di 11 ore di stacco.');
  if (['M', 'P', 'N'].includes(kind)) {
    const lav = ['M', 'P', 'N', 'T1018'];
    if (serie(lav, -1) + serie(lav, 1) + 1 > 4) avvisi.push('Più di 4 giorni di lavoro consecutivi.');
    if (db.shifts.some((s) => s.date === date && s.kind === kind && s.staff_id !== staffId)
      || (db.richieste || []).some((r) => r.date === date && r.kind === kind && r.status === 'pending' && r.staff_id !== staffId && r.id !== escludi)) {
      err('Quel turno è già stato chiesto o assegnato a un altro collega.');
    }
  } else {
    const chi = new Set([
      ...db.shifts.filter((s) => s.date === date && ['R', 'RR'].includes(s.kind) && s.staff_id !== staffId).map((s) => s.staff_id),
      ...(db.richieste || []).filter((r) => r.date === date && r.kind === 'RR' && r.status === 'pending' && r.staff_id !== staffId && r.id !== escludi).map((r) => r.staff_id),
    ]);
    if (estate && chi.size >= 1) err('D\'estate in un giorno può riposare una sola persona: quel giorno c\'è già un riposo.');
    if (chi.size >= 2) err('Quel giorno ci sono già due riposi.');
    if (chi.size === 1) avvisi.push('È il secondo riposo di quel giorno.');
    if (estate && (['R', 'RR'].includes(prima) || ['R', 'RR'].includes(dopo))) avvisi.push('D\'estate non sono previsti due riposi di fila.');
  }
  return avvisi;
}

// Ferie e permessi: blocca giorno occupato e periodi troppo lunghi (sabati e domeniche, anche a inizio e fine, diventano il trattino); avvisa se sono già assenti almeno 2 colleghi
export function controllaFerie(db, staffId, da, a, escludi = null) {
  const tipo = (d) => db.shifts.find((s) => s.staff_id === staffId && s.date === d && PRINCIPALI.includes(s.kind))?.kind
    || (db.richieste || []).find((r) => r.staff_id === staffId && r.status === 'pending' && r.id !== escludi && d >= r.date && d <= (r.last_date || r.date))?.kind || null;
  if (a < da) err('L\'ultimo giorno è prima del primo.');
  if ((Date.parse(a) - Date.parse(da)) / 864e5 > 44) err('Al massimo 45 giorni per volta.');
  const persona = (db.staff || []).find((p) => p.id === staffId);
  const dom = (d) => giornoLibero(persona, d);
  const operatori = new Set((db.staff || []).filter((p) => p.role === 'operator').map((p) => p.id));
  const giorni = [];
  for (let d = da; d <= a; d = giorno(d, 1)) {
    const t = tipo(d);
    if (t && t !== 'R') err(`Il ${d.slice(8, 10)}/${d.slice(5, 7)} hai già un turno, un riposo, un'assenza o una richiesta.`);
    const chi = new Set([
      ...db.shifts.filter((s) => s.date === d && ['F', 'FS', 'PERM'].includes(s.kind) && s.staff_id !== staffId && operatori.has(s.staff_id)).map((s) => s.staff_id),
      ...(db.richieste || []).filter((r) => r.status === 'pending' && ['F', 'PERM'].includes(r.kind) && r.staff_id !== staffId && r.id !== escludi && operatori.has(r.staff_id) && d >= r.date && d <= (r.last_date || r.date)).map((r) => r.staff_id),
    ]);
    if (chi.size >= 2 && !dom(d)) giorni.push(`${d.slice(8, 10)}/${d.slice(5, 7)}`);
  }
  return giorni.length ? [`Sono già assenti almeno 2 colleghi (ferie o permessi) nei giorni: ${giorni.join(', ')}.`] : [];
}
// giorno che dentro ferie e permessi diventa il trattino: la domenica per tutti, il sabato per chi ha il contratto senza weekend (Marie)
export function giornoLibero(persona, d) {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow === 0 || (dow === 6 && !!persona?.senza_weekend);
}
// giorni di una richiesta di ferie o permesso: i giorni liberi in mezzo sono il trattino (FS)
export function giorniAssenza(da, a, kind, persona = null) {
  const out = [];
  for (let d = da; d <= a; d = giorno(d, 1)) out.push({ date: d, kind: giornoLibero(persona, d) ? 'FS' : kind });
  return out;
}
// Chi non lavora nel weekend (Marie) ha sabato e domenica come R di default, anche se nessuno li ha scritti:
// serve a ricordare agli operatori che quei giorni non c'è. Compaiono solo nei giorni ancora vuoti.
export function weekendPredefinito(staff, year, month, shifts) {
  const out = [];
  const giorniMese = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (const p of staff.filter((x) => x.senza_weekend && x.active !== false)) {
    for (let g = 1; g <= giorniMese; g++) {
      const d = `${year}-${String(month).padStart(2, '0')}-${String(g).padStart(2, '0')}`;
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) continue;
      if (p.start_date && d < p.start_date) continue;
      if (p.end_date && d > p.end_date) continue;
      if (shifts.some((s) => s.staff_id === p.id && s.date === d && PRINCIPALI.includes(s.kind))) continue;
      out.push({ staff_id: p.id, date: d, kind: 'R', requested: false, implicito: true });
    }
  }
  return out;
}

export const MAX_RICHIESTE = 3;
// Marie ha tempo fino a mezzanotte del giorno dopo la scadenza degli operatori (il 21); poi le richieste aperte valgono come accettate
export const decisioneRichieste = (y, m) => { const sc = scadenzaRichieste(y, m); return `${sc.slice(0, 8)}${String(Number(sc.slice(8)) + 1).padStart(2, '0')}`; };
// Le richieste di un mese sono sempre aperte: dal 1 ottobre dell'anno prima fino alla mezzanotte (ora italiana) del 20 del mese prima.
export const scadenzaRichieste = (y, m) => { const p = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; return `${p.y}-${String(p.m).padStart(2, '0')}-20`; };
export const inizioRichieste = (y) => `${y - 1}-10-01`;
// la data di oggi è sempre quella di Roma (la scadenza scatta a mezzanotte italiana, qualunque sia il fuso del dispositivo)
export const oggiRoma = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const richiesteAperte = (y, m, oggi = oggiRoma()) => oggi >= inizioRichieste(y) && oggi <= scadenzaRichieste(y, m);
// elenco dei mesi con le richieste aperte oggi (da questo mese a 26 mesi avanti)
export function mesiConRichieste(oggi = oggiRoma()) {
  const out = []; let y = +oggi.slice(0, 4), m = +oggi.slice(5, 7);
  for (let i = 0; i <= 26; i++) {
    if (richiesteAperte(y, m, oggi)) out.push({ year: y, month: m, scadenza: scadenzaRichieste(y, m) });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
