// Generatore automatico dei turni del mese (bozza).
//
// Idea: ogni regola ha un costo e il programma cerca il piano che costa meno. Le regole non si "violano" mai di nascosto:
// se il mese lo permette nessuna regola viene violata; se non lo permette cedono per prime quelle con il costo più basso.
// L'ordine di rinuncia (dalla prima a cadere all'ultima) è quello di COSTI qui sotto.
//
// Il piano copre i giorni del mese più il 1° del mese dopo ("anticipo"), così il mese successivo parte già impostato.
// Come storia si usano gli ultimi giorni del mese prima (notti comprese) e tutto l'anno fin lì: turni M/P/N, weekend liberi
// e doppie notti di ognuno, per tenere equilibrato non solo il mese ma l'intero calendario, come se fosse una sola striscia.
//
// Il modulo non usa il DOM e non usa librerie esterne: gira nel browser e nei test (Node).

// --------------------------------------------------------------------------- costi (ordine di rinuncia: dal più basso al più alto)
export const COSTI = {
  secondoWeekend: 2,       //  1. meno di 2 weekend completamente liberi (per ogni weekend mancante)
  scostTipo: 3,            //  2. equilibrio: ogni turno di scarto dal numero "giusto" di mattine / pomeriggi / notti
  scostTotale: 6,          //     e dal totale "giusto" di turni (tenendo conto anche dei mesi passati)
  doppiaNotte: 20,         //  3. due notti consecutive (di più per chi ne ha già fatte tante)
  venerdiNotte: 25,        //     notte del venerdì sul sabato: quasi come un weekend libero, ma meglio non darla
  quattroDiFila: 30,       //  4. 4 giorni di fila (meglio al massimo 3)
  alternanza: 90,          //  5. stesso turno ripetuto nella stessa settimana (2ª volta, e ancora di più la 3ª)
  sabatoEDomenica: 200,    //  6. lavorare sia il sabato sia la domenica dello stesso weekend
  nessunWeekend: 500,      //  7. nessun weekend completamente libero nel mese
  oltre4: 1500,            //  8. più di 4 giorni di fila
  undiciOre: 3000,         //  9. mattina dopo un pomeriggio (meno di 11 ore)
  riposoDopoNotte: 5000,   // 10. lavorare il giorno dopo la notte o il giorno di riposo obbligato
  tripleNotte: 8000,       //     tre notti di fila
  scoperto: 100000,        // 11. un turno senza nessuno (o con due persone)
};
const PREMIO_WEEKEND = 4;  // piccolo vantaggio per ogni weekend libero in più, maggiore per chi ne ha avuti meno nei mesi scorsi

const TURNI = ['M', 'P', 'N'];
const ASSENZE = ['F', 'FS', 'PERM', 'RR', 'RB', 'MU'];      // giorni in cui non si lavora
export const DEFAULT_TEMPO = 30;                            // secondi concessi alla ricerca
const GIORNI_PRIMA = 6;                                     // quanti giorni del mese prima servono (settimana a cavallo dei mesi)

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const giorniNelMese = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (data) => new Date(`${data}T00:00:00Z`).getUTCDay();      // 0 = domenica
const spostaGiorno = (data, n) => { const x = new Date(`${data}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const clip = (v, a, b) => Math.max(a, Math.min(b, v));

// --------------------------------------------------------------------------- preparazione dei dati
// dati = {
//   year, month,
//   staff:   [{ id, name, role, active, fixed_pattern, fixed_days, contract_hours, start_date, end_date }],
//   shifts:  righe già nel foglio (il mese + il 1° del mese dopo) [{ staff_id, date, kind, requested }],
//   prima:   righe degli ultimi giorni del mese precedente (almeno 6),
//   storico: { [staff_id]: { M, P, N } }              turni fatti dall'inizio dell'anno,
//   weekendStorico: { [staff_id]: { liberi, totale } } weekend liberi dall'inizio dell'anno,
//   doppieStorico: { [staff_id]: n }                   doppie notti dall'inizio dell'anno,
//   anticipoBloccato: true se il mese dopo è già pubblicato (il suo 1° giorno non si tocca),
//   modalita: 'tutto' | 'vuoti'
// }
// D = giorni del mese; DX = D + 1 (il giorno d'anticipo); DG = ultimo giorno da generare.
export function costruisciModello(dati) {
  const { year: Y, month: Mo, modalita = 'tutto' } = dati;
  const D = giorniNelMese(Y, Mo), DX = D + 1, DG = dati.anticipoBloccato ? D : DX;
  const dataDi = (d) => spostaGiorno(iso(Y, Mo, 1), d - 1);          // d = 1 è il primo del mese; d <= 0 è il mese prima
  const info = { conflitti: [] };

  const primo = iso(Y, Mo, 1), ultimo = iso(Y, Mo, D);
  const operatori = dati.staff.filter((p) => p.role === 'operator' && p.active !== false
    && (!p.start_date || p.start_date <= ultimo) && (!p.end_date || p.end_date >= primo));
  const fissi = operatori.filter((p) => p.fixed_pattern);
  const flessibili = operatori.filter((p) => !p.fixed_pattern);

  // situazione di partenza di ogni casella: { assente, lavoro: 'M'|'P'|'N'|null (turno già fissato), occupato (es. 10-18) }
  const righe = new Map();
  for (const s of dati.shifts || []) {
    const k = `${s.staff_id}|${s.date}`;
    if (!righe.has(k)) righe.set(k, []);
    righe.get(k).push(s);
  }
  const riga = (o, data) => righe.get(`${o}|${data}`) || [];
  const stato = {};
  for (const p of operatori) {
    stato[p.id] = {};
    for (let d = 1; d <= DX; d++) {
      const data = dataDi(d);
      const rr = riga(p.id, data);
      const st = { assente: false, lavoro: null, occupato: false, stab: false };
      if (p.start_date && data < p.start_date) st.assente = true;
      if (p.end_date && data > p.end_date) st.assente = true;
      const haMalattia = rr.some((r) => r.kind === 'MU');
      // il giorno d'anticipo con il mese dopo già pubblicato è tutto fisso; nella modalità "solo vuote" sono fissi tutti i turni scritti
      const fermo = modalita === 'vuoti' || d === 1 || (dati.anticipoBloccato && d === DX);   // il 1° giorno l'ha già deciso il piano del mese prima
      for (const r of rr) {
        if (ASSENZE.includes(r.kind)) st.assente = true;
        if (r.kind === 'T1018') st.occupato = true;
        if (TURNI.includes(r.kind) && (r.requested || haMalattia || fermo)) st.lavoro = r.kind;
        // turni "stabiliti": richiesti e accettati, di malattia, o decisi dal mese prima / dal mese dopo già pubblicato.
        // Non li sceglie il generatore: se tra loro creano un conflitto, il conflitto non gli va attribuito.
        if (TURNI.includes(r.kind) && (r.requested || haMalattia || d === 1 || (dati.anticipoBloccato && d === DX))) st.stab = true;
        if (r.kind === 'R' && !r.requested && fermo) st.assente = true;
      }
      stato[p.id][d] = st;
    }
  }
  const passato = {};                                               // turni dei giorni prima dell'inizio del mese (costanti)
  for (const p of operatori) {
    passato[p.id] = {};
    for (let d = -GIORNI_PRIMA; d <= 0; d++) {
      const data = dataDi(d);
      const r = (dati.prima || []).filter((s) => s.staff_id === p.id && s.date === data && TURNI.includes(s.kind));
      passato[p.id][d] = r.length ? r[0].kind : null;
    }
  }

  // valori fissi: fisso[o][d] = { M, P, N } con 0/1 se la casella è già decisa; vuoto se la sceglie il programma
  const fisso = {};
  for (const p of operatori) {
    fisso[p.id] = {};
    for (let d = -GIORNI_PRIMA; d <= DX; d++) {
      if (d <= 0) { const t = passato[p.id][d]; fisso[p.id][d] = { M: +(t === 'M'), P: +(t === 'P'), N: +(t === 'N') }; continue; }
      const st = stato[p.id][d];
      const f = {};
      if (st.lavoro) for (const s of TURNI) f[s] = +(st.lavoro === s);
      else if (st.assente || st.occupato || (dati.anticipoBloccato && d === DX)) for (const s of TURNI) f[s] = 0;
      else if (p.fixed_pattern) {
        const t = (p.fixed_days || {})[dow(dataDi(d))] || null;
        for (const s of TURNI) f[s] = +(t === s);
      }
      fisso[p.id][d] = f;
    }
  }
  // la notte non può iniziare il giorno prima di un'assenza (ferie, permesso, riposo richiesto): il giorno dopo la notte si è ancora in turno fino alle 7
  for (const p of flessibili) {
    for (let d = 1; d < DX; d++) {
      const prossimo = stato[p.id][d + 1];
      if (prossimo && prossimo.assente && fisso[p.id][d].N === undefined) fisso[p.id][d].N = 0;
    }
  }

  // weekend interi dentro il mese
  const weekend = [];
  for (let d = 1; d < D; d++) if (dow(dataDi(d)) === 6) weekend.push([d, d + 1]);
  // notti del venerdì (sul sabato)
  const venerdi = new Set();
  for (let d = 1; d <= DG; d++) if (dow(dataDi(d)) === 5) venerdi.add(d);

  // memoria dei weekend e delle doppie notti degli ultimi mesi: chi ne ha avuti meno / di più viene compensato
  const memoriaOp = {}, moltDoppie = {};
  const tassi = {};
  for (const p of flessibili) { const w = (dati.weekendStorico || {})[p.id]; if (w && w.totale > 0) tassi[p.id] = w.liberi / w.totale; }
  const tassoMedio = Object.keys(tassi).length ? Object.values(tassi).reduce((a, b) => a + b, 0) / Object.keys(tassi).length : null;
  const doppieMedie = (() => { const v = flessibili.map((p) => (dati.doppieStorico || {})[p.id] || 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; })();
  for (const p of flessibili) {
    memoriaOp[p.id] = tassoMedio === null || tassi[p.id] === undefined ? 0 : clip((tassoMedio - tassi[p.id]) * 3, -1, 1);
    moltDoppie[p.id] = Math.max(0.3, 1 + clip(((dati.doppieStorico || {})[p.id] || 0) - doppieMedie, -2, 3) * 0.4);
  }

  // equilibrio: numero "giusto" di M/P/N nel mese per ognuno, corretto con quanto già fatto nell'anno
  const bersagli = {}, bersaglioTotale = {};
  if (flessibili.length) {
    const giorniLiberi = (p) => { let n = 0; for (let d = 1; d <= D; d++) if (!stato[p.id][d].assente && !stato[p.id][d].occupato) n++; return n; };
    const peso = new Map(flessibili.map((p) => [p.id, Math.max(0.0001, giorniLiberi(p)) * (p.contract_hours > 0 ? p.contract_hours / 160 : 1)]));
    const sommaPeso = [...peso.values()].reduce((a, b) => a + b, 0);
    const domanda = (s) => D - fissi.reduce((a, p) => { let n = 0; for (let d = 1; d <= D; d++) n += fisso[p.id][d][s] || 0; return a + n; }, 0);
    for (const s of TURNI) {
      const dem = domanda(s);
      const annoTot = flessibili.reduce((a, p) => a + ((dati.storico || {})[p.id]?.[s] || 0), 0);
      for (const p of flessibili) {
        const base = dem * peso.get(p.id) / sommaPeso;
        let target = base;
        if (dati.storico) {
          const ideale = (annoTot + dem) * peso.get(p.id) / sommaPeso;
          const serve = ideale - ((dati.storico[p.id] || {})[s] || 0);
          target = clip(base + 0.7 * (serve - base), base - 3, base + 3);
        }
        (bersagli[p.id] ||= {})[s] = Math.max(0, target);
        bersaglioTotale[p.id] = (bersaglioTotale[p.id] || 0) + Math.max(0, target);
      }
    }
  }

  // settimane (lunedì-domenica) per l'alternanza: la prima parte dal lunedì, anche se cade nel mese prima
  const settimane = [];
  const giorniDalLunedi = (dow(primo) + 6) % 7;
  for (let d = 1, ini = 1 - giorniDalLunedi; d <= DX; d++) if (d === DX || dow(dataDi(d)) === 0) { settimane.push([ini, d]); ini = d + 1; }

  return {
    info,
    meta: { Y, Mo, D, DX, DG, operatori: operatori.map((p) => p.id), flessibili: flessibili.map((p) => p.id), fissi: fissi.map((p) => p.id), weekend, settimane },
    _interni: { fisso, stato, dataDi, passato, stab: (o, d) => d <= 0 || !!(stato[o][d] && stato[o][d].stab), operatori, memoriaOp, moltDoppie, bersagli, bersaglioTotale, venerdi },
  };
}

// --------------------------------------------------------------------------- ricerca locale
// Parte da un piano costruito turno per turno e lo migliora per tentativi (ricottura simulata): sposta un turno da un
// operatore a un altro o scambia i turni di due operatori (anche per più giorni di fila), tenendo i cambi che abbassano il
// costo (o, all'inizio, anche qualcuno che lo alza un po', per non restare bloccata).
const BIT = { M: 1, P: 2, N: 4 };
const OFF = GIORNI_PRIMA + 1;
const pop = (x) => (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1);
function generatoreCasuale(seme) {
  let a = seme >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function unaRicerca(m, { tempo, seme, progresso, T0 = 120, T1 = 0.4 }) {
  const { D, DX, DG, flessibili, weekend, settimane } = m.meta;
  const { fisso, stato, memoriaOp, moltDoppie, bersagli, bersaglioTotale, operatori, venerdi } = m._interni;
  const rnd = generatoreCasuale(seme);
  const ops = flessibili; const nOp = ops.length;
  const tutti = operatori.map((p) => p.id);
  const len = DX + 1 + OFF;
  const riga = ops.map(() => new Int8Array(len));
  const lib = (i, d, s) => fisso[ops[i]][d]?.[s] === undefined;           // la casella è una scelta del programma?

  // turni già fissi (passato, richieste, malattia, schema di Andrea…)
  ops.forEach((o, i) => { for (let d = -GIORNI_PRIMA; d <= DX; d++) for (const s of TURNI) if (fisso[o][d]?.[s] === 1) riga[i][d + OFF] |= BIT[s]; });
  const occup = ops.map((o) => { const a = new Uint8Array(len); for (let d = 1; d <= DX; d++) a[d + OFF] = stato[o][d].occupato ? 1 : 0; return a; });

  // caselle (giorno, turno) da assegnare: quelle che nessuno ha già fissato
  const slot = [];
  for (let d = 1; d <= DG; d++) for (const s of TURNI) {
    const gia = tutti.filter((o) => fisso[o][d]?.[s] === 1).length;
    if (gia === 0) {
      const cand = []; for (let i = 0; i < nOp; i++) if (lib(i, d, s)) cand.push(i);
      slot.push({ d, s, cand, owner: -1 });
    }
  }
  const idx = {}; slot.forEach((sl, k) => { idx[sl.d * 4 + TURNI.indexOf(sl.s)] = k; });

  const occ = new Uint8Array(len);
  function costo(i) {
    const o = ops[i], r = riga[i];
    for (let d = -3; d <= DX; d++) occ[d + OFF] = (d >= 1 && occup[i][d + OFF]) || r[d + OFF] !== 0 || (r[d - 1 + OFF] & 4) ? 1 : 0;
    let c = 0;
    let nM = 0, nP = 0, nN = 0;
    for (let d = 1; d <= DX; d++) {
      const b = r[d + OFF], pr = r[d - 1 + OFF], pr2 = r[d - 2 + OFF];
      const cnt = pop(b), nPrev = (pr & 4) ? 1 : 0, nPrev2 = (pr2 & 4) ? 1 : 0;
      if (d <= D) { if (b & 1) nM++; if (b & 2) nP++; if (b & 4) nN++; }
      if (cnt > 1) c += COSTI.riposoDopoNotte * (cnt - 1);
      const mp = (b & 1 ? 1 : 0) + (b & 2 ? 1 : 0);
      if (mp + nPrev > 1) c += COSTI.riposoDopoNotte * (mp + nPrev - 1);
      if (nPrev2 + cnt > 1) c += COSTI.riposoDopoNotte * (nPrev2 + cnt - 1);
      if ((pr & 2) && (b & 1)) c += COSTI.undiciOre;
      if ((b & 4) && nPrev) c += COSTI.doppiaNotte * moltDoppie[o];
      if ((b & 4) && venerdi.has(d)) c += COSTI.venerdiNotte;
      if (d + 2 <= DX && (b & 4) && (r[d + 1 + OFF] & 4) && (r[d + 2 + OFF] & 4)) c += COSTI.tripleNotte;
    }
    for (let d = -3; d <= DX - 4; d++) { const t = occ[d + OFF] + occ[d + 1 + OFF] + occ[d + 2 + OFF] + occ[d + 3 + OFF] + occ[d + 4 + OFF]; if (t > 4) c += COSTI.oltre4 * (t - 4); }
    for (let d = -2; d <= DX - 3; d++) { const t = occ[d + OFF] + occ[d + 1 + OFF] + occ[d + 2 + OFF] + occ[d + 3 + OFF]; if (t > 3) c += COSTI.quattroDiFila * (t - 3); }
    for (const [a, b] of settimane) {
      if (b <= a) continue;
      let cm = 0, cp = 0, cn = 0;
      for (let d = a; d <= b; d++) { const x = r[d + OFF]; if (x & 1) cm++; if (x & 2) cp++; if (x & 4) cn++; }
      if (cm > 1) c += COSTI.alternanza * (cm - 1 + (cm > 2 ? cm - 2 : 0));
      if (cp > 1) c += COSTI.alternanza * (cp - 1 + (cp > 2 ? cp - 2 : 0));
      if (cn > 1) c += COSTI.alternanza * (cn - 1 + (cn > 2 ? cn - 2 : 0));
    }
    if (weekend.length) {
      // weekend libero = nessun turno il sabato e nessun turno la domenica (né la notte del sabato, che finisce la domenica);
      // la notte del venerdì finisce il sabato alle 7: non toglie il weekend
      let liberi = 0; const premio = PREMIO_WEEKEND * (1 + 0.75 * (memoriaOp[o] || 0));
      for (const [sa, su] of weekend) {
        const a = r[sa + OFF] !== 0 || occup[i][sa + OFF] === 1;
        const b = r[su + OFF] !== 0 || (r[sa + OFF] & 4) !== 0 || occup[i][su + OFF] === 1;
        if (!a && !b) { liberi++; c -= premio; }
        if (a && b) c += COSTI.sabatoEDomenica;
      }
      if (liberi < 1) c += COSTI.nessunWeekend;
      c += COSTI.secondoWeekend * Math.max(0, Math.min(2, weekend.length) - liberi);
    }
    const bt = bersagli[o];
    if (bt) {
      c += COSTI.scostTipo * (Math.abs(nM - bt.M) + Math.abs(nP - bt.P) + Math.abs(nN - bt.N));
      c += COSTI.scostTotale * Math.abs(nM + nP + nN - bersaglioTotale[o]);
    }
    return c;
  }
  const costoOp = new Float64Array(nOp);
  const metti = (i, d, s) => { riga[i][d + OFF] |= BIT[s]; };
  const togli = (i, d, s) => { riga[i][d + OFF] &= ~BIT[s]; };

  // piano di partenza: ogni turno al candidato che costa meno in quel momento
  for (let i = 0; i < nOp; i++) costoOp[i] = costo(i);
  const ordine = slot.map((_, k) => k).sort((a, b) => slot[a].cand.length - slot[b].cand.length || slot[a].d - slot[b].d);
  for (const k of ordine) {
    const sl = slot[k]; let best = -1, bd = Infinity;
    for (const i of sl.cand) {
      metti(i, sl.d, sl.s); const c = costo(i) - costoOp[i]; togli(i, sl.d, sl.s);
      const x = c + rnd() * 0.5;
      if (x < bd) { bd = x; best = i; }
    }
    if (best >= 0) { sl.owner = best; metti(best, sl.d, sl.s); costoOp[best] = costo(best); }
  }
  let totale = 0; for (let i = 0; i < nOp; i++) totale += costoOp[i];
  let costoTot = totale + COSTI.scoperto * slot.reduce((a, sl) => a + (sl.owner < 0 ? 1 : 0), 0);
  let migliore = costoTot, copia = slot.map((sl) => sl.owner);

  // ricottura
  const mobili = slot.map((_, k) => k).filter((k) => slot[k].cand.length > 1);
  const inizio = Date.now(), durata = tempo * 1000;
  let it = 0, ultimoProg = 0, T = T0;
  while (mobili.length) {
    if ((it & 255) === 0) {
      const t = Date.now() - inizio;
      if (t >= durata) break;
      if (progresso && Date.now() - ultimoProg > 500) { ultimoProg = Date.now(); progresso(t / durata, migliore); await new Promise((r) => setTimeout(r, 0)); }
      T = T0 * Math.pow(T1 / T0, Math.min(1, t / durata));
    }
    it++;
    const k1 = mobili[(rnd() * mobili.length) | 0], s1 = slot[k1];
    if (rnd() < 0.5) {
      // sposta il turno a un altro operatore
      const nuovo = s1.cand[(rnd() * s1.cand.length) | 0], vecchio = s1.owner;
      if (nuovo === vecchio) continue;
      if (vecchio >= 0) togli(vecchio, s1.d, s1.s);
      metti(nuovo, s1.d, s1.s);
      const cV = vecchio >= 0 ? costo(vecchio) : 0, cN = costo(nuovo);
      const delta = (cN - costoOp[nuovo]) + (vecchio >= 0 ? cV - costoOp[vecchio] : -COSTI.scoperto);
      if (delta <= 0 || rnd() < Math.exp(-delta / Math.max(T, 1e-6))) {
        s1.owner = nuovo; costoOp[nuovo] = cN; if (vecchio >= 0) costoOp[vecchio] = cV; costoTot += delta;
      } else { togli(nuovo, s1.d, s1.s); if (vecchio >= 0) metti(vecchio, s1.d, s1.s); }
    } else {
      // scambia i turni di due operatori, per un solo turno o per un blocco di giorni consecutivi
      const k2 = mobili[(rnd() * mobili.length) | 0], s2 = slot[k2];
      const a = s1.owner, b = s2.owner;
      if (a < 0 || b < 0 || a === b) continue;
      const blocco = rnd() < 0.5 ? 1 + ((rnd() * 7) | 0) : 0;
      let cambi;                                                        // [slot, da, a]
      if (blocco) {
        cambi = [];
        const d0 = Math.max(1, s1.d - ((rnd() * blocco) | 0));
        for (let d = d0; d < d0 + blocco && d <= DG; d++) for (let t = 0; t < 3; t++) {
          const k = idx[d * 4 + t]; if (k === undefined) continue;
          const o = slot[k].owner;
          if (o === a) cambi.push([k, a, b]); else if (o === b) cambi.push([k, b, a]);
        }
        if (!cambi.length || cambi.some(([k, , n]) => !lib(n, slot[k].d, slot[k].s))) continue;
      } else {
        if (k1 === k2 || !lib(a, s2.d, s2.s) || !lib(b, s1.d, s1.s)) continue;
        cambi = [[k1, a, b], [k2, b, a]];
      }
      for (const [k, da] of cambi) togli(da, slot[k].d, slot[k].s);
      for (const [k, , aa] of cambi) metti(aa, slot[k].d, slot[k].s);
      const cA = costo(a), cB = costo(b);
      const delta = (cA - costoOp[a]) + (cB - costoOp[b]);
      if (delta <= 0 || rnd() < Math.exp(-delta / Math.max(T, 1e-6))) {
        for (const [k, , aa] of cambi) slot[k].owner = aa;
        costoOp[a] = cA; costoOp[b] = cB; costoTot += delta;
      } else {
        for (const [k, , aa] of cambi) togli(aa, slot[k].d, slot[k].s);
        for (const [k, da] of cambi) metti(da, slot[k].d, slot[k].s);
      }
    }
    if (costoTot < migliore - 1e-9) { migliore = costoTot; copia = slot.map((sl) => sl.owner); }
  }
  const valori = {};
  slot.forEach((sl, k) => { const i = copia[k]; if (i >= 0) valori[`x_${sl.s}_${ops[i]}_${sl.d}`] = 1; });
  return { stato: 'Ricerca locale', valori, costo: migliore, passi: it };
}

// Tre ricerche indipendenti, una dopo l'altra, e si tiene la migliore (partendo da punti diversi il risultato cambia un po').
export async function risolviLocale(m, { tempo = DEFAULT_TEMPO, seme = Math.floor(Math.random() * 1e9), progresso = null, T0, T1 } = {}) {
  const giri = 3; let migliore = null, passi = 0;
  for (let g = 0; g < giri; g++) {
    const r = await unaRicerca(m, { tempo: tempo / giri, seme: seme + g * 7919, T0, T1, progresso: progresso ? (f, c) => progresso((g + f) / giri, Math.min(c, migliore ? migliore.costo : c)) : null });
    passi += r.passi;
    if (!migliore || r.costo < migliore.costo) migliore = r;
  }
  return { ...migliore, passi };
}

// --------------------------------------------------------------------------- lettura della soluzione
// valori: { x_M_<persona>_<giorno>: 1 } per le caselle scelte dal programma
export function leggiSoluzione(m, valori, dati) {
  const { D, DX, DG } = m.meta;
  const { fisso, stato, dataDi, operatori } = m._interni;
  const modalita = dati.modalita || 'tutto';
  const val = (nome) => Math.round(valori[nome] ?? 0);
  const assegn = {}; const scoperti = [];                           // assegn[o][d] = 'M'|'P'|'N'|null
  for (const p of operatori) {
    assegn[p.id] = {};
    for (let d = -GIORNI_PRIMA; d <= DX; d++) {
      let t = null;
      for (const s of TURNI) {
        const f = fisso[p.id][d]?.[s];
        const v = f !== undefined ? f : val(`x_${s}_${p.id}_${d}`);
        if (v === 1) t = s;
      }
      assegn[p.id][d] = t;
    }
  }
  for (let d = 1; d <= DG; d++) for (const s of TURNI) {
    const chi = operatori.filter((p) => assegn[p.id][d] === s);
    if (chi.length !== 1) scoperti.push({ date: dataDi(d), kind: s, persone: chi.length, anticipo: d > D });
  }
  // nella modalità "rifà tutto" le righe non richieste (e senza malattia) vengono cancellate prima di scrivere: non contano come già presenti
  const malati = new Set((dati.shifts || []).filter((s) => s.kind === 'MU').map((s) => `${s.staff_id}|${s.date}`));
  const primoGiorno = dataDi(1);
  const resta = (dati.shifts || []).filter((s) => modalita === 'vuoti' || s.date === primoGiorno || s.requested || malati.has(`${s.staff_id}|${s.date}`) || !['M', 'P', 'N', 'R'].includes(s.kind));
  const esistenti = new Set(resta.map((s) => `${s.staff_id}|${s.date}|${s.kind}`));
  const haRiga = new Set(resta.map((s) => `${s.staff_id}|${s.date}`));
  const righe = [];
  const protette = (o, d) => stato[o][d] && (stato[o][d].assente || stato[o][d].occupato);
  for (const p of operatori) {
    for (let d = 1; d <= DG; d++) {
      const t = assegn[p.id][d];
      if (!t) continue;
      const data = dataDi(d);
      if (esistenti.has(`${p.id}|${data}|${t}`)) continue;
      if (modalita === 'vuoti' && haRiga.has(`${p.id}|${data}`)) continue;
      righe.push({ staff_id: p.id, date: data, kind: t });
    }
    // riposo obbligato: due giorni dopo l'inizio dell'ultima notte di una serie
    for (let d = -1; d <= DG; d++) {
      if (assegn[p.id][d] !== 'N' || assegn[p.id][d + 1] === 'N') continue;
      const r = d + 2;
      if (r < 1 || r > DG) continue;
      const data = dataDi(r);
      if (assegn[p.id][r] || protette(p.id, r)) continue;
      if (haRiga.has(`${p.id}|${data}`) && (modalita === 'vuoti' || esistenti.has(`${p.id}|${data}|R`))) continue;
      righe.push({ staff_id: p.id, date: data, kind: 'R' });
    }
  }
  return { righe, scoperti, assegn };
}

// --------------------------------------------------------------------------- controllo del piano finale
// Rilegge il piano e conta le regole che restano violate e i totali per persona: serve per l'anteprima.
export function riepilogo(m, sol) {
  const { D, DX, DG, operatori: ids, fissi, weekend, settimane } = m.meta;
  const { assegn } = sol;
  const { stato, dataDi, stab } = m._interni;
  // un conflitto si segnala solo se almeno uno dei turni coinvolti l'ha scelto il generatore
  const sceltoGen = (o, d) => !!at(o, d) && !stab(o, d);
  const nome = new Map(m._interni.operatori.map((p) => [p.id, p.name]));
  const at = (o, d) => assegn[o][d] || null;
  const gg = (d) => { const x = dataDi(d); return `${x.slice(8, 10)}/${x.slice(5, 7)}`; };
  const persone = [];
  const problemi = [];
  for (const o of ids) {
    const conta = { M: 0, P: 0, N: 0 };
    for (let d = 1; d <= D; d++) { const t = at(o, d); if (t) conta[t]++; }
    let doppie = 0, oltre4 = 0, oltre4Gen = 0, maxFila = 0, fila = 0;
    const occupa = (d) => !!(at(o, d) || at(o, d - 1) === 'N' || (d >= 1 && stato[o][d] && stato[o][d].occupato));
    for (let d = 1; d <= DG; d++) {
      if (at(o, d) === 'N' && at(o, d + 1) === 'N' && d < D) doppie++;
      if (at(o, d) === 'P' && at(o, d + 1) === 'M' && d + 1 <= DG && (sceltoGen(o, d) || sceltoGen(o, d + 1))) problemi.push(`${nome.get(o)}: mattina dopo un pomeriggio il ${gg(d + 1)}`);
      if (at(o, d) === 'N' && d + 2 <= DG && at(o, d + 2) && (sceltoGen(o, d) || sceltoGen(o, d + 2))) problemi.push(`${nome.get(o)}: turno il giorno di riposo dopo la notte (${gg(d + 2)})`);
      if (at(o, d - 1) === 'N' && (at(o, d) === 'M' || at(o, d) === 'P') && (sceltoGen(o, d - 1) || sceltoGen(o, d))) problemi.push(`${nome.get(o)}: turno subito dopo la notte (${gg(d)})`);
      fila = occupa(d) ? fila + 1 : 0; maxFila = Math.max(maxFila, fila);
    }
    for (let d = 1; d + 4 <= DG; d++) if ([0, 1, 2, 3, 4].every((k) => occupa(d + k))) {
      oltre4++;
      if ([-1, 0, 1, 2, 3, 4].some((k) => sceltoGen(o, d + k))) oltre4Gen++;
    }
    let liberi = null, meta = null, pieni = null, pieniGen = 0;
    if (!fissi.includes(o) && weekend.length) {
      liberi = 0; meta = 0; pieni = 0;
      for (const [sa, su] of weekend) {
        const a = !!(at(o, sa) || (stato[o][sa] && stato[o][sa].occupato));
        const b = !!(at(o, su) || at(o, sa) === 'N' || (stato[o][su] && stato[o][su].occupato));
        const n = (a ? 1 : 0) + (b ? 1 : 0);
        if (n === 0) liberi++; else if (n === 1) meta++; else { pieni++; if ([sa - 1, sa, su].some((x) => sceltoGen(o, x))) pieniGen++; }
      }
    }
    // alternanza: settimane in cui lo stesso turno torna 3 volte o più
    let ripetute = 0;
    if (!fissi.includes(o)) for (const [a, b] of settimane) {
      for (const t of TURNI) {
        let n = 0; for (let d = a; d <= b; d++) if (at(o, d) === t) n++;
        if (n >= 3 && [...Array(b - a + 1).keys()].some((k) => at(o, a + k) === t && sceltoGen(o, a + k))) { ripetute++; problemi.push(`${nome.get(o)}: stesso turno (${t}) ${n} volte nella settimana dal ${gg(a)}`); }
      }
    }
    persone.push({ id: o, nome: nome.get(o), ...conta, totale: conta.M + conta.P + conta.N, doppie, oltre4, oltre4Gen, maxFila, weekendLiberi: liberi, weekendMezzi: meta, weekendPieni: pieni, pieniGen, ripetute, fisso: fissi.includes(o) });
  }
  for (const p of persone) {
    if (p.oltre4Gen) problemi.push(`${p.nome}: più di 4 giorni di fila (${p.maxFila})`);
    if (p.weekendLiberi === 0) problemi.push(`${p.nome}: nessun weekend con sabato e domenica entrambi liberi`);
    if (p.pieniGen) problemi.push(`${p.nome}: sabato e domenica entrambi di lavoro in ${p.pieniGen} weekend`);
  }
  // anticipo sul mese dopo: chi fa cosa il 1° giorno
  let anticipo = null;
  if (DG === DX) {
    anticipo = { data: dataDi(DX), M: null, P: null, N: null };
    for (const o of ids) { const t = at(o, DX); if (t) anticipo[t] = nome.get(o); }
  }
  return { persone, scoperti: sol.scoperti, problemi: [...new Set(problemi)], anticipo };
}

// --------------------------------------------------------------------------- storico (mese precedente e anno in corso)
// righe: turni M/P/N di tutto l'anno prima del mese da generare [{staff_id, date, kind}]
export function calcolaStorico(righe, y, m) {
  const primo = iso(y, m, 1), gennaio = iso(y, 1, 1), daPrima = spostaGiorno(primo, -GIORNI_PRIMA);
  const tutte = (righe || []).filter((r) => TURNI.includes(r.kind) && r.date < primo);
  const turni = tutte.filter((r) => r.date >= gennaio);                // l'anno in corso
  const storico = {}, prima = [], doppieStorico = {};
  for (const r of turni) (storico[r.staff_id] ||= { M: 0, P: 0, N: 0 })[r.kind]++;
  for (const r of tutte) if (r.date >= daPrima) prima.push({ staff_id: r.staff_id, date: r.date, kind: r.kind });   // a gennaio anche dicembre
  const ha = new Set(turni.map((r) => `${r.staff_id}|${r.date}|${r.kind}`));
  const ids = [...new Set(turni.map((r) => r.staff_id))];
  const giorniConDati = new Set(turni.map((r) => r.date));
  for (const r of turni) if (r.kind === 'N' && ha.has(`${r.staff_id}|${spostaGiorno(r.date, 1)}|N`)) doppieStorico[r.staff_id] = (doppieStorico[r.staff_id] || 0) + 1;
  // weekend liberi dall'inizio dell'anno (sabato e domenica entrambi senza turni, né la notte del sabato); solo i weekend con dati
  const weekendStorico = {};
  const lavora = (o, data) => TURNI.some((k) => ha.has(`${o}|${data}|${k}`));
  for (let d = gennaio; d < primo; d = spostaGiorno(d, 1)) {
    if (dow(d) !== 6) continue;
    const su = spostaGiorno(d, 1);
    if (su >= primo) continue;
    if (![spostaGiorno(d, -1), d, su, spostaGiorno(su, 1)].some((x) => giorniConDati.has(x))) continue;
    for (const o of ids) {
      const w = (weekendStorico[o] ||= { liberi: 0, totale: 0 });
      w.totale++;
      if (!lavora(o, d) && !lavora(o, su) && !ha.has(`${o}|${d}|N`)) w.liberi++;
    }
  }
  return { storico, prima, weekendStorico, doppieStorico };
}

// --------------------------------------------------------------------------- tutto insieme
export async function generaPiano(dati, opzioni = {}) {
  const m = costruisciModello(dati);
  const risposta = await risolviLocale(m, opzioni);
  const sol = leggiSoluzione(m, risposta.valori, dati);
  return { ...sol, riepilogo: riepilogo(m, sol), stato: risposta.stato, costo: risposta.costo, modello: m };
}
