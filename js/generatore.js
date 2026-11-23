// Generatore automatico dei turni del mese (bozza).
//
// Idea: un modello a vincoli (programmazione lineare a numeri interi). Per ogni operatore e giorno una variabile 0/1
// per M, P e N. Le regole non si "violano" mai di nascosto: ognuna ha una variabile di scarto con un costo, e i costi
// seguono l'ordine concordato (si rilassa per prima la regola meno importante):
//   doppie notti  <  weekend  <  giorni di fila  <  11 ore  <  riposo dopo la notte  <  turno scoperto.
// Il solver (HiGHS) cerca il piano con il costo più basso; se il mese è fattibile nessuna regola viene violata,
// se non lo è violerà solo le regole meno importanti e il minimo indispensabile.
//
// Il modulo non usa il DOM: la stessa funzione `costruisciModello` gira nel browser e nei test (Node).
// Il modello è indipendente dal solver: si scrive in formato LP (testo) e lo si passa a HiGHS (WebAssembly nel browser).

// --------------------------------------------------------------------------- costi (ordine di rilassamento)
export const COSTI = {
  scoperto: 100000,        // un turno senza nessuno (e un turno con due persone)
  riposoDopoNotte: 5000,   // lavorare il giorno dopo la notte o il giorno di riposo obbligato
  undiciOre: 3000,         // mattina dopo un pomeriggio
  oltre4: 1500,            // più di 4 giorni di fila
  nessunWeekend: 300,      // nemmeno un weekend libero nel mese
  tripleNotte: 8000,       // tre notti di fila (mai)
  doppiaNotte: 40,         // due notti consecutive
  secondoWeekend: 20,      // meno di 2 weekend liberi
  sabatoEDomenica: 15,     // lavorare sia il sabato sia la domenica dello stesso weekend
  quattroDiFila: 6,        // 4 giorni di fila (meglio 3)
  scostTipo: 3,            // ogni turno di scarto dal numero "giusto" di mattine / pomeriggi / notti
  scostTotale: 6,          // ogni turno di scarto dal totale "giusto"
};

const TURNI = ['M', 'P', 'N'];
const ASSENZE = ['F', 'FS', 'PERM', 'RR', 'RB', 'MU'];      // giorni in cui non si lavora
export const DEFAULT_TEMPO = 30;                            // secondi concessi alla ricerca

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const giorniNelMese = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (data) => new Date(`${data}T00:00:00Z`).getUTCDay();      // 0 = domenica
const spostaGiorno = (data, n) => { const x = new Date(`${data}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const clip = (v, a, b) => Math.max(a, Math.min(b, v));

// --------------------------------------------------------------------------- costruzione del modello
// dati = {
//   year, month,
//   staff:   [{ id, name, role, active, fixed_pattern, fixed_days, contract_hours, start_date, end_date }],
//   shifts:  righe già nel mese [{ staff_id, date, kind, requested }],
//   prima:   righe degli ultimi giorni del mese precedente (almeno 5 giorni),
//   storico: { [staff_id]: { M, P, N } }   turni fatti dall'inizio dell'anno (facoltativo),
//   weekendPrima: { [staff_id]: n }        weekend liberi del mese precedente (facoltativo),
//   modalita: 'tutto' | 'vuoti'
// }
export function costruisciModello(dati) {
  const { year: Y, month: Mo, modalita = 'tutto' } = dati;
  const D = giorniNelMese(Y, Mo);
  const dataDi = (d) => spostaGiorno(iso(Y, Mo, 1), d - 1);          // d = 1 è il primo del mese; d <= 0 è il mese prima
  const info = { conflitti: [], noteSolo: [] };

  // ------------------------------------------------ chi partecipa
  const primo = iso(Y, Mo, 1), ultimo = iso(Y, Mo, D);
  const operatori = dati.staff.filter((p) => p.role === 'operator' && p.active !== false
    && (!p.start_date || p.start_date <= ultimo) && (!p.end_date || p.end_date >= primo));
  const fissi = operatori.filter((p) => p.fixed_pattern);
  const flessibili = operatori.filter((p) => !p.fixed_pattern);
  const id = (p) => p.id;

  // ------------------------------------------------ situazione di partenza di ogni casella (persona, giorno)
  // stato[o][d]: { assente, lavoro: 'M'|'P'|'N'|null (turno già fissato), occupato (altro turno fisso, es. 10-18) }
  const righe = new Map();                                          // `${staff}|${date}` -> [{kind, requested}]
  for (const s of dati.shifts || []) {
    const k = `${s.staff_id}|${s.date}`;
    if (!righe.has(k)) righe.set(k, []);
    righe.get(k).push(s);
  }
  const riga = (o, data) => righe.get(`${o}|${data}`) || [];
  const stato = {};
  for (const p of operatori) {
    stato[p.id] = {};
    for (let d = 1; d <= D; d++) {
      const data = dataDi(d);
      const rr = riga(p.id, data);
      const st = { assente: false, lavoro: null, occupato: false };
      if (p.start_date && data < p.start_date) st.assente = true;
      if (p.end_date && data > p.end_date) st.assente = true;
      const haMalattia = rr.some((r) => r.kind === 'MU');
      for (const r of rr) {
        if (ASSENZE.includes(r.kind)) st.assente = true;
        if (r.kind === 'T1018') st.occupato = true;
        if (TURNI.includes(r.kind)) {
          // fissi: i turni richiesti (accettati), quelli con la malattia sopra e, nella modalità "solo vuote", tutti
          if (r.requested || haMalattia || modalita === 'vuoti') st.lavoro = r.kind;
        }
        // un riposo scritto a mano resta tale solo nella modalità "solo vuote"
        if (r.kind === 'R' && !r.requested && modalita === 'vuoti') st.assente = true;
      }
      stato[p.id][d] = st;
    }
  }
  // turni dei giorni prima dell'inizio del mese (costanti)
  const passato = {};                                               // passato[o][d] per d <= 0: 'M'|'P'|'N'|null
  for (const p of operatori) {
    passato[p.id] = {};
    for (let d = -4; d <= 0; d++) {
      const data = dataDi(d);
      const r = (dati.prima || []).filter((s) => s.staff_id === p.id && s.date === data && TURNI.includes(s.kind));
      passato[p.id][d] = r.length ? r[0].kind : null;
    }
  }

  // ------------------------------------------------ valori fissi dei turni
  // fisso[o][d] = { M, P, N } con 0/1 se noto, altrimenti assente
  const fisso = {};
  for (const p of operatori) {
    fisso[p.id] = {};
    for (let d = -4; d <= D; d++) {
      if (d <= 0) { const t = passato[p.id][d]; fisso[p.id][d] = { M: +(t === 'M'), P: +(t === 'P'), N: +(t === 'N') }; continue; }
      const st = stato[p.id][d];
      const f = {};
      if (st.lavoro) {
        for (const s of TURNI) f[s] = +(st.lavoro === s);
      } else if (st.assente || st.occupato) {
        for (const s of TURNI) f[s] = 0;
      } else if (p.fixed_pattern) {
        const t = (p.fixed_days || {})[dow(dataDi(d))] || null;
        for (const s of TURNI) f[s] = +(t === s);
      }
      fisso[p.id][d] = f;
    }
  }
  // dopo una notte non si può essere assenti il giorno dopo l'inizio della notte (ferie, permesso, riposo richiesto)
  for (const p of flessibili) {
    for (let d = 1; d <= D; d++) {
      const prossimo = d < D ? stato[p.id][d + 1] : null;
      if (prossimo && prossimo.assente && fisso[p.id][d].N === undefined) fisso[p.id][d].N = 0;
    }
  }

  // ------------------------------------------------ variabili e vincoli
  const vars = [];                    // { nome, tipo: 'bin'|'cont', lb, ub, c }
  const vIdx = new Map();
  const cons = [];                    // { nome, lo, hi, t: [[nome, coef]] }
  const nuova = (nome, tipo, lb, ub, c = 0) => { if (!vIdx.has(nome)) { vIdx.set(nome, vars.length); vars.push({ nome, tipo, lb, ub, c }); } return nome; };
  let nCon = 0;
  // un termine è [rif, coef]; rif = { v: nome } oppure { k: costante }
  const V = (nome) => ({ v: nome });
  const K = (k) => ({ k });
  const con = (termini, lo, hi, etichetta = 'c') => {
    let costante = 0; const t = new Map();
    for (const [rif, coef] of termini) {
      if (rif.k !== undefined) costante += rif.k * coef;
      else t.set(rif.v, (t.get(rif.v) || 0) + coef);
    }
    const l = lo === null ? null : lo - costante, h = hi === null ? null : hi - costante;
    const lista = [...t.entries()].filter(([, c]) => c !== 0);
    if (!lista.length) {
      if ((l !== null && l > 1e-9) || (h !== null && h < -1e-9)) info.conflitti.push(etichetta);
      return;
    }
    cons.push({ nome: `${etichetta}${++nCon}`, lo: l, hi: h, t: lista });
  };

  // x(o, s, d): variabile o costante
  const X = (o, s, d) => {
    const f = fisso[o][d];
    if (f && f[s] !== undefined) return K(f[s]);
    return V(nuova(`x_${s}_${o}_${d}`, 'bin', 0, 1));
  };

  // occupazione (lavora oppure sta finendo la notte)
  const occCache = new Map();
  const occ = (o, d) => {
    const key = `${o}|${d}`;
    if (occCache.has(key)) return occCache.get(key);
    const comp = [...TURNI.map((s) => X(o, s, d)), d >= -3 ? X(o, 'N', d - 1) : K(0)];
    // il giorno dopo l'inizio della notte si è ancora "occupati" (la notte finisce alle 7)
    let r;
    if (comp.every((c) => c.k !== undefined)) r = K(Math.max(...comp.map((c) => c.k)));
    else {
      const nome = nuova(`o_${o}_${d}`, 'cont', 0, 1);
      for (const c of comp) con([[V(nome), 1], [c, -1]], 0, null, 'occ');
      r = V(nome);
    }
    occCache.set(key, r);
    return r;
  };
  // occupazione con "T1018" (turno 10-18 già fissato) e giorni fissi fuori dai turni M/P/N
  const occTot = (o, d) => {
    if (d >= 1 && stato[o][d].occupato) return K(1);
    return occ(o, d);
  };

  // --- copertura
  for (let d = 1; d <= D; d++) {
    for (const s of TURNI) {
      const t = operatori.map((p) => [X(p.id, s, d), 1]);
      const u = nuova(`u_${s}_${d}`, 'bin', 0, 1, COSTI.scoperto);
      const w = nuova(`w_${s}_${d}`, 'bin', 0, 1, COSTI.scoperto);
      con([...t, [V(u), 1], [V(w), -1]], 1, 1, 'cop');
    }
  }

  // --- regole per gli operatori flessibili
  const penalita = (nome, c, ub = 1, tipo = 'cont') => nuova(nome, tipo, 0, ub, c);
  for (const p of flessibili) {
    const o = p.id;
    for (let d = 1; d <= D; d++) {
      // un solo turno al giorno
      con(TURNI.map((s) => [X(o, s, d), 1]), null, 1, 'uno');
      // il giorno dopo la notte niente mattina o pomeriggio (la notte può continuare)
      const r1 = penalita(`r1_${o}_${d}`, COSTI.riposoDopoNotte, 1, 'bin');
      con([[X(o, 'M', d), 1], [X(o, 'P', d), 1], [X(o, 'N', d - 1), 1], [V(r1), -1]], null, 1, 'dopoN');
      // due giorni dopo l'inizio di una notte è il riposo obbligato: nessun turno (neppure un'altra notte)
      const r2 = penalita(`r2_${o}_${d}`, COSTI.riposoDopoNotte, 1, 'bin');
      con([[X(o, 'N', d - 2), 1], ...TURNI.map((s) => [X(o, s, d), 1]), [V(r2), -1]], null, 1, 'riposoN');
      // 11 ore: mattina dopo pomeriggio
      const r3 = penalita(`r3_${o}_${d}`, COSTI.undiciOre, 1, 'bin');
      con([[X(o, 'P', d - 1), 1], [X(o, 'M', d), 1], [V(r3), -1]], null, 1, 'undici');
      // doppia notte (non da privilegiare)
      if (d >= 1) {
        const nn = penalita(`nn_${o}_${d}`, COSTI.doppiaNotte);
        con([[V(nn), 1], [X(o, 'N', d - 1), -1], [X(o, 'N', d), -1]], -1, null, 'doppiaN');
      }
    }
    // giorni di fila: finestre di 5 giorni al massimo 4; finestre di 4 giorni preferibilmente al massimo 3
    for (let d = -3; d <= D - 4; d++) {
      const w5 = penalita(`w5_${o}_${d + 10}`, COSTI.oltre4);
      con([...[0, 1, 2, 3, 4].map((k) => [occTot(o, d + k), 1]), [V(w5), -1]], null, 4, 'fila5');
    }
    for (let d = -2; d <= D - 3; d++) {
      const w4 = penalita(`w4_${o}_${d + 10}`, COSTI.quattroDiFila);
      con([...[0, 1, 2, 3].map((k) => [occTot(o, d + k), 1]), [V(w4), -1]], null, 3, 'fila4');
    }
    // tre notti di fila: mai
    for (let d = 1; d + 2 <= D; d++) {
      const r4 = penalita(`r4_${o}_${d}`, COSTI.tripleNotte, 1, 'bin');
      con([[X(o, 'N', d), 1], [X(o, 'N', d + 1), 1], [X(o, 'N', d + 2), 1], [V(r4), -1]], null, 2, 'triplaN');
    }
  }

  // --- weekend (solo i weekend interi dentro il mese)
  const weekend = [];
  for (let d = 1; d < D; d++) if (dow(dataDi(d)) === 6) weekend.push([d, d + 1]);
  const memoriaOp = {}, bersagli = {}, bersaglioTotale = {};
  const mediaPrima = (() => {
    const v = flessibili.map((p) => (dati.weekendPrima || {})[p.id]).filter((x) => x !== undefined);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();
  if (weekend.length) {
    for (const p of flessibili) {
      const o = p.id;
      const memoria = mediaPrima === null || (dati.weekendPrima || {})[o] === undefined ? 0 : clip(mediaPrima - dati.weekendPrima[o], -1, 1);
      memoriaOp[o] = memoria;
      const fw = weekend.map(([sa, su], w) => {
        const f = nuova(`fw_${o}_${w}`, 'bin', 0, 1, -2 * (1 + 0.5 * memoria));
        con([[occTot(o, sa), 1], [V(f), 1]], null, 1, 'wk');
        con([[occTot(o, su), 1], [V(f), 1]], null, 1, 'wk');
        const bw = penalita(`bw_${o}_${w}`, COSTI.sabatoEDomenica);
        con([[V(bw), 1], [occTot(o, sa), -1], [occTot(o, su), -1]], -1, null, 'bw');
        return f;
      });
      const s1 = nuova(`s1_${o}`, 'bin', 0, 1, COSTI.nessunWeekend);
      con([...fw.map((f) => [V(f), 1]), [V(s1), 1]], 1, null, 'w1');
      const s2 = nuova(`s2_${o}`, 'cont', 0, 2, COSTI.secondoWeekend);
      con([...fw.map((f) => [V(f), 1]), [V(s2), 1]], Math.min(2, weekend.length), null, 'w2');
    }
  }

  // --- equilibrio mensile (e annuale) tra i flessibili
  if (flessibili.length) {
    const giorniLiberi = (p) => { let n = 0; for (let d = 1; d <= D; d++) if (!stato[p.id][d].assente && !stato[p.id][d].occupato) n++; return n; };
    const peso = new Map(flessibili.map((p) => [p.id, Math.max(0.0001, giorniLiberi(p)) * (p.contract_hours > 0 ? p.contract_hours / 160 : 1)]));
    const sommaPeso = [...peso.values()].reduce((a, b) => a + b, 0);
    // turni già assegnati ai fissi (pattern di Andrea)
    const domanda = (s) => D - fissi.reduce((a, p) => { let n = 0; for (let d = 1; d <= D; d++) n += fisso[p.id][d][s] || 0; return a + n; }, 0);
    const bersaglioTot = new Map();
    for (const s of TURNI) {
      const dem = domanda(s);
      const annoTot = flessibili.reduce((a, p) => a + ((dati.storico || {})[p.id]?.[s] || 0), 0);
      for (const p of flessibili) {
        const base = dem * peso.get(p.id) / sommaPeso;
        let target = base;
        if (dati.storico) {
          const ideale = (annoTot + dem) * peso.get(p.id) / sommaPeso;
          const serve = ideale - ((dati.storico[p.id] || {})[s] || 0);
          target = clip(base + 0.5 * (serve - base), base - 2, base + 2);
        }
        target = Math.max(0, target);
        (bersagli[p.id] ||= {})[s] = target;
        const conta = []; for (let d = 1; d <= D; d++) conta.push([X(p.id, s, d), 1]);
        const dv = nuova(`dv_${s}_${p.id}`, 'cont', 0, 60, COSTI.scostTipo);
        con([...conta, [V(dv), -1]], null, target, 'scT');
        con([...conta, [V(dv), 1]], target, null, 'scT');
        bersaglioTot.set(p.id, (bersaglioTot.get(p.id) || 0) + target);
      }
    }
    for (const p of flessibili) {
      const conta = []; for (let d = 1; d <= D; d++) for (const s of TURNI) conta.push([X(p.id, s, d), 1]);
      const dv = nuova(`dt_${p.id}`, 'cont', 0, 80, COSTI.scostTotale);
      const t = bersaglioTot.get(p.id);
      bersaglioTotale[p.id] = t;
      con([...conta, [V(dv), -1]], null, t, 'scTot');
      con([...conta, [V(dv), 1]], t, null, 'scTot');
    }
  }

  const modello = { vars, cons, info, meta: { Y, Mo, D, operatori: operatori.map(id), flessibili: flessibili.map(id), fissi: fissi.map(id), weekend } };
  modello._interni = { fisso, stato, dataDi, passato, operatori, memoriaOp, bersagli, bersaglioTotale };
  return modello;
}

// --------------------------------------------------------------------------- formato LP (CPLEX) per HiGHS
const num = (x) => {
  const s = Number.isInteger(x) ? String(x) : x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
export function scriviLP(m) {
  const out = [];
  const lineaObj = m.vars.filter((v) => v.c !== 0).map((v) => `${v.c < 0 ? '-' : '+'} ${num(Math.abs(v.c))} ${v.nome}`);
  out.push('Minimize');
  out.push(' obj: ' + (lineaObj.length ? lineaObj.join(' ') : '0 ' + m.vars[0].nome));
  out.push('Subject To');
  const espr = (t) => t.map(([n, c], i) => `${c < 0 ? '-' : (i ? '+' : '')} ${num(Math.abs(c))} ${n}`.trim()).join(' ');
  for (const c of m.cons) {
    const e = espr(c.t);
    if (c.lo !== null && c.hi !== null && Math.abs(c.lo - c.hi) < 1e-9) out.push(` ${c.nome}: ${e} = ${num(c.lo)}`);
    else {
      if (c.lo !== null) out.push(` ${c.nome}_g: ${e} >= ${num(c.lo)}`);
      if (c.hi !== null) out.push(` ${c.nome}_l: ${e} <= ${num(c.hi)}`);
    }
  }
  out.push('Bounds');
  for (const v of m.vars) if (v.tipo === 'cont') out.push(` ${num(v.lb)} <= ${v.nome} <= ${num(v.ub)}`);
  const bin = m.vars.filter((v) => v.tipo === 'bin').map((v) => v.nome);
  if (bin.length) { out.push('Binary'); for (let i = 0; i < bin.length; i += 12) out.push(' ' + bin.slice(i, i + 12).join(' ')); }
  out.push('End');
  return out.join('\n') + '\n';
}

// --------------------------------------------------------------------------- lettura della soluzione
// valori: { nomeVariabile: valore }
export function leggiSoluzione(m, valori, dati) {
  const { Y, Mo, D } = m.meta;
  const { fisso, stato, dataDi, operatori } = m._interni;
  const modalita = dati.modalita || 'tutto';
  const val = (nome) => Math.round(valori[nome] ?? 0);
  // assegnazione finale: assegn[o][d] = 'M'|'P'|'N'|null
  const assegn = {}; const scoperti = [];
  for (const p of operatori) {
    assegn[p.id] = {};
    for (let d = -4; d <= D; d++) {
      let t = null;
      for (const s of TURNI) {
        const f = fisso[p.id][d]?.[s];
        const v = f !== undefined ? f : val(`x_${s}_${p.id}_${d}`);
        if (v === 1) t = s;
      }
      assegn[p.id][d] = t;
    }
  }
  for (let d = 1; d <= D; d++) for (const s of TURNI) {
    const chi = operatori.filter((p) => assegn[p.id][d] === s);
    if (chi.length !== 1) scoperti.push({ date: dataDi(d), kind: s, persone: chi.length });
  }
  // righe da scrivere: turni M/P/N e riposi obbligati, solo dove la casella era libera
  // nella modalità "rifà tutto" le righe non richieste (e senza malattia) vengono cancellate prima di scrivere: non contano come già presenti
  const malati = new Set((dati.shifts || []).filter((s) => s.kind === 'MU').map((s) => `${s.staff_id}|${s.date}`));
  const resta = (dati.shifts || []).filter((s) => modalita === 'vuoti' || s.requested || malati.has(`${s.staff_id}|${s.date}`) || !['M', 'P', 'N', 'R'].includes(s.kind));
  const esistenti = new Set(resta.map((s) => `${s.staff_id}|${s.date}|${s.kind}`));
  const haRiga = new Set(resta.map((s) => `${s.staff_id}|${s.date}`));
  const righe = [];
  const protette = (o, d) => stato[o][d] && (stato[o][d].assente || stato[o][d].occupato);
  for (const p of operatori) {
    for (let d = 1; d <= D; d++) {
      const t = assegn[p.id][d];
      if (!t) continue;
      const data = dataDi(d);
      if (esistenti.has(`${p.id}|${data}|${t}`)) continue;
      if (modalita === 'vuoti' && haRiga.has(`${p.id}|${data}`)) continue;
      righe.push({ staff_id: p.id, date: data, kind: t });
    }
    // riposo obbligato: due giorni dopo l'inizio dell'ultima notte di una serie
    for (let d = -1; d <= D; d++) {
      if (assegn[p.id][d] !== 'N' || assegn[p.id][d + 1] === 'N') continue;
      const r = d + 2;
      if (r < 1 || r > D) continue;
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
  const { D, operatori: ids, flessibili, fissi, weekend } = m.meta;
  const { assegn } = sol;
  const { stato } = m._interni;
  const nome = new Map(m._interni.operatori.map((p) => [p.id, p.name]));
  const at = (o, d) => assegn[o][d] || null;
  const persone = [];
  const problemi = [];
  for (const o of ids) {
    const conta = { M: 0, P: 0, N: 0 };
    for (let d = 1; d <= D; d++) { const t = at(o, d); if (t) conta[t]++; }
    let doppie = 0, oltre4 = 0, undici = 0, riposo = 0, maxFila = 0, fila = 0;
    for (let d = 1; d <= D; d++) {
      if (at(o, d) === 'N' && at(o, d + 1) === 'N') doppie++;
      if (at(o, d) === 'P' && at(o, d + 1) === 'M') { undici++; problemi.push(`${nome.get(o)}: mattina dopo un pomeriggio il ${d + 1}`); }
      if (at(o, d) === 'N' && at(o, d + 2) && at(o, d + 2) !== undefined) { riposo++; problemi.push(`${nome.get(o)}: turno il giorno di riposo dopo la notte (${d + 2})`); }
      if (at(o, d - 1) === 'N' && (at(o, d) === 'M' || at(o, d) === 'P')) { riposo++; problemi.push(`${nome.get(o)}: turno subito dopo la notte (${d})`); }
      const occupa = at(o, d) || at(o, d - 1) === 'N' || (stato[o][d] && stato[o][d].occupato);
      fila = occupa ? fila + 1 : 0; maxFila = Math.max(maxFila, fila);
    }
    for (let d = 1; d + 4 <= D; d++) {
      const w = [0, 1, 2, 3, 4].every((k) => at(o, d + k) || at(o, d + k - 1) === 'N');
      if (w) { oltre4++; }
    }
    let liberi = null;
    if (!fissi.includes(o) && weekend.length) {
      liberi = weekend.filter(([sa, su]) => !at(o, sa) && !(at(o, sa - 1) === 'N') && !at(o, su) && !(at(o, su - 1) === 'N')).length;
    }
    persone.push({ id: o, nome: nome.get(o), ...conta, totale: conta.M + conta.P + conta.N, doppie, oltre4, maxFila, weekendLiberi: liberi, fisso: fissi.includes(o) });
  }
  for (const p of persone) {
    if (p.oltre4) problemi.push(`${p.nome}: più di 4 giorni di fila (${p.maxFila})`);
    if (p.weekendLiberi === 0) problemi.push(`${p.nome}: nessun weekend libero`);
  }
  return { persone, scoperti: sol.scoperti, problemi: [...new Set(problemi)] };
}

// --------------------------------------------------------------------------- ricerca locale (la soluzione usata dall'app)
// Parte da un piano costruito turno per turno e lo migliora per tentativi (ricottura simulata): sposta un turno da un
// operatore a un altro o scambia due turni, tenendo ogni volta solo i cambi che abbassano il costo (o, all'inizio, quasi).
// Il costo è lo stesso del modello esatto: stesse regole, stessi pesi. Funziona dentro il browser, senza librerie esterne.
const BIT = { M: 1, P: 2, N: 4 };
const OFF = 4;
const pop = (x) => (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1);
function generatoreCasuale(seme) {
  let a = seme >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function unaRicerca(m, { tempo, seme, progresso, T0 = 120, T1 = 0.4 }) {
  const { D, flessibili, weekend } = m.meta;
  const { fisso, stato, memoriaOp, bersagli, bersaglioTotale, operatori } = m._interni;
  const rnd = generatoreCasuale(seme);
  const ops = flessibili; const nOp = ops.length;
  const tutti = operatori.map((p) => p.id);
  const len = D + 1 + OFF;
  const riga = ops.map(() => new Int8Array(len));
  const lib = (i, d, s) => fisso[ops[i]][d]?.[s] === undefined;           // la casella è una scelta del programma?

  // turni già fissi (passato, richieste, malattia, schema di Andrea…)
  ops.forEach((o, i) => { for (let d = -OFF; d <= D; d++) for (const s of TURNI) if (fisso[o][d]?.[s] === 1) riga[i][d + OFF] |= BIT[s]; });
  const occup = ops.map((o) => { const a = new Uint8Array(len); for (let d = 1; d <= D; d++) a[d + OFF] = stato[o][d].occupato ? 1 : 0; return a; });

  // caselle (giorno, turno) da assegnare: quelle che nessuno ha già fissato
  const slot = [];
  for (let d = 1; d <= D; d++) for (const s of TURNI) {
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
    for (let d = -3; d <= D; d++) occ[d + OFF] = (d >= 1 && occup[i][d + OFF]) || r[d + OFF] !== 0 || (r[d - 1 + OFF] & 4) ? 1 : 0;
    let c = 0;
    let nM = 0, nP = 0, nN = 0;
    for (let d = 1; d <= D; d++) {
      const b = r[d + OFF], pr = r[d - 1 + OFF], pr2 = r[d - 2 + OFF];
      const cnt = pop(b), nPrev = (pr & 4) ? 1 : 0, nPrev2 = (pr2 & 4) ? 1 : 0;
      if (b & 1) nM++; if (b & 2) nP++; if (b & 4) nN++;
      if (cnt > 1) c += COSTI.riposoDopoNotte * (cnt - 1);
      const mp = (b & 1 ? 1 : 0) + (b & 2 ? 1 : 0);
      if (mp + nPrev > 1) c += COSTI.riposoDopoNotte * (mp + nPrev - 1);
      if (nPrev2 + cnt > 1) c += COSTI.riposoDopoNotte * (nPrev2 + cnt - 1);
      if ((pr & 2) && (b & 1)) c += COSTI.undiciOre;
      if ((b & 4) && nPrev) c += COSTI.doppiaNotte;
      if (d + 2 <= D && (b & 4) && (r[d + 1 + OFF] & 4) && (r[d + 2 + OFF] & 4)) c += COSTI.tripleNotte;
    }
    for (let d = -3; d <= D - 4; d++) { const t = occ[d + OFF] + occ[d + 1 + OFF] + occ[d + 2 + OFF] + occ[d + 3 + OFF] + occ[d + 4 + OFF]; if (t > 4) c += COSTI.oltre4 * (t - 4); }
    for (let d = -2; d <= D - 3; d++) { const t = occ[d + OFF] + occ[d + 1 + OFF] + occ[d + 2 + OFF] + occ[d + 3 + OFF]; if (t > 3) c += COSTI.quattroDiFila * (t - 3); }
    if (weekend.length) {
      let liberi = 0; const memo = memoriaOp[o] || 0;
      for (const [sa, su] of weekend) {
        const a = occ[sa + OFF], b = occ[su + OFF];
        if (!a && !b) { liberi++; c -= 2 * (1 + 0.5 * memo); }
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
  const scop = () => slot.reduce((a, sl) => a + (sl.owner < 0 ? 1 : 0), 0);
  let costoTot = totale + COSTI.scoperto * scop();
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
    }
    if ((it & 255) === 0) T = T0 * Math.pow(T1 / T0, Math.min(1, (Date.now() - inizio) / durata));
    it++;
    const k1 = mobili[(rnd() * mobili.length) | 0], s1 = slot[k1];
    if (rnd() < 0.5) {
      // sposta il turno a un altro operatore
      const nuovo = s1.cand[(rnd() * s1.cand.length) | 0], vecchio = s1.owner;
      if (nuovo === vecchio) continue;
      if (vecchio >= 0) togli(vecchio, s1.d, s1.s);
      metti(nuovo, s1.d, s1.s);
      const cV = vecchio >= 0 ? costo(vecchio) : 0, cN = costo(nuovo);
      const delta = (cN - costoOp[nuovo]) + (vecchio >= 0 ? cV - costoOp[vecchio] : COSTI.scoperto * -1);
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
        for (let d = d0; d < d0 + blocco && d <= D; d++) for (let t = 0; t < 3; t++) {
          const k = idx[d * 4 + t]; if (k === undefined) continue;
          const o = slot[k].owner;
          if (o === a) cambi.push([k, a, b]); else if (o === b) cambi.push([k, b, a]);
        }
        if (!cambi.length || cambi.some(([k, , n]) => !lib(n, slot[k].d, slot[k].s))) continue;
      } else {
        if (k1 === k2 || !lib(a, s2.d, s2.s) || !lib(b, s1.d, s1.s)) continue;
        cambi = [[k1, a, b], [k2, b, a]];
      }
      for (const [k, da, aa] of cambi) { togli(da, slot[k].d, slot[k].s); }
      for (const [k, , aa] of cambi) { metti(aa, slot[k].d, slot[k].s); }
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

// --------------------------------------------------------------------------- storico (mese precedente e anno in corso)
// righe: turni M/P/N di tutto l'anno prima del mese da generare [{staff_id, date, kind}]
export function calcolaStorico(righe, y, m, nomiOperatori = null) {
  const primo = iso(y, m, 1), gennaio = iso(y, 1, 1), da5 = spostaGiorno(primo, -5);
  const turni = (righe || []).filter((r) => TURNI.includes(r.kind) && r.date >= gennaio && r.date < primo);
  const storico = {}, prima = [];
  for (const r of turni) {
    (storico[r.staff_id] ||= { M: 0, P: 0, N: 0 })[r.kind]++;
    if (r.date >= da5) prima.push({ staff_id: r.staff_id, date: r.date, kind: r.kind });
  }
  // weekend liberi del mese prima (solo se di quel mese ci sono turni)
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1, nPm = giorniNelMese(py, pm);
  const delPrec = turni.filter((r) => r.date >= iso(py, pm, 1));
  const weekendPrima = {};
  if (delPrec.length) {
    const ids = new Set(turni.map((r) => r.staff_id));
    const ha = new Set(delPrec.map((r) => `${r.staff_id}|${r.date}|${r.kind}`));
    const lavora = (o, data) => TURNI.some((k) => ha.has(`${o}|${data}|${k}`));
    for (const o of ids) {
      let n = 0;
      for (let d = 1; d < nPm; d++) {
        const sa = iso(py, pm, d);
        if (dow(sa) !== 6) continue;
        const su = iso(py, pm, d + 1);
        if (!lavora(o, sa) && !lavora(o, su) && !ha.has(`${o}|${spostaGiorno(sa, -1)}|N`)) n++;
      }
      weekendPrima[o] = n;
    }
  }
  return { storico, prima, weekendPrima };
}

// --------------------------------------------------------------------------- tutto insieme
export async function generaPiano(dati, opzioni = {}) {
  const m = costruisciModello(dati);
  let risposta;
  if (opzioni.risolvi) risposta = await opzioni.risolvi(scriviLP(m), opzioni);        // solo per le prove: solver esterno
  else risposta = await risolviLocale(m, opzioni);
  const sol = leggiSoluzione(m, risposta.valori, dati);
  return { ...sol, riepilogo: riepilogo(m, sol), stato: risposta.stato, costo: risposta.costo, modello: m };
}
