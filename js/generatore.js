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
export const DEFAULT_TEMPO = 60;                            // secondi concessi al solver

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
  const mediaPrima = (() => {
    const v = flessibili.map((p) => (dati.weekendPrima || {})[p.id]).filter((x) => x !== undefined);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();
  if (weekend.length) {
    for (const p of flessibili) {
      const o = p.id;
      const memoria = mediaPrima === null || (dati.weekendPrima || {})[o] === undefined ? 0 : clip(mediaPrima - dati.weekendPrima[o], -1, 1);
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
      con([...conta, [V(dv), -1]], null, t, 'scTot');
      con([...conta, [V(dv), 1]], t, null, 'scTot');
    }
  }

  const modello = { vars, cons, info, meta: { Y, Mo, D, operatori: operatori.map(id), flessibili: flessibili.map(id), fissi: fissi.map(id), weekend } };
  modello._interni = { fisso, stato, dataDi, passato, operatori };
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
  const esistenti = new Set((dati.shifts || []).map((s) => `${s.staff_id}|${s.date}|${s.kind}`));
  const haRiga = new Set((dati.shifts || []).map((s) => `${s.staff_id}|${s.date}`));
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

// --------------------------------------------------------------------------- risoluzione con HiGHS (nel browser)
// HiGHS compilato in WebAssembly (pacchetto "highs"), caricato da una rete di distribuzione al primo uso e
// fatto girare in un Web Worker, così la pagina resta fluida durante il calcolo.
const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/';

export function risolviNelBrowser(lp, { tempo = DEFAULT_TEMPO } = {}) {
  // Il solver in WebAssembly può cadere con certe opzioni: si prova una serie di impostazioni, dalla più completa alla più
  // semplice, ognuna con un solver nuovo (dopo un errore quello vecchio non è più affidabile). Si usa la prima che funziona.
  const sorgente = `
    self.onmessage = async (ev) => {
      const errori = [];
      try { importScripts('${HIGHS_BASE}highs.js'); } catch (e) { self.postMessage({ ok: false, errore: 'Caricamento del solver non riuscito: ' + (e && e.message || e) }); return; }
      const fabbrica = (typeof Module === 'function' ? Module : (typeof Highs === 'function' ? Highs : (typeof highs === 'function' ? highs : null)));
      if (!fabbrica) { self.postMessage({ ok: false, errore: 'Caricamento del solver non riuscito.' }); return; }
      const t = ev.data.tempo;
      const tentativi = [
        { nome: 'standard', opz: { time_limit: t, mip_rel_gap: 0.01 } },
        { nome: 'senza presolve', opz: { time_limit: t, mip_rel_gap: 0.01, presolve: 'off' } },
        { nome: 'minimo', opz: { time_limit: t } },
        { nome: 'minimo senza presolve', opz: { time_limit: t, presolve: 'off' } },
      ];
      for (const tent of tentativi) {
        try {
          const highs = await fabbrica({ locateFile: (f) => '${HIGHS_BASE}' + f });
          const sol = highs.solve(ev.data.lp, tent.opz);
          const valori = {};
          for (const [nome, c] of Object.entries(sol.Columns || {})) valori[nome] = c.Primal;
          if (!Object.keys(valori).length) { errori.push(tent.nome + ': nessun piano (' + sol.Status + ')'); continue; }
          self.postMessage({ ok: true, stato: sol.Status, valori, tentativo: tent.nome, errori });
          return;
        } catch (e) { errori.push(tent.nome + ': ' + String(e && e.message || e)); }
      }
      self.postMessage({ ok: false, errore: errori.join(' | ') });
    };`;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([sorgente], { type: 'application/javascript' }));
    const w = new Worker(url);
    const chiudi = () => { w.terminate(); URL.revokeObjectURL(url); };
    const guardia = setTimeout(() => { chiudi(); reject(new Error('Il calcolo ha impiegato troppo tempo.')); }, (tempo * 4 + 60) * 1000);
    w.onmessage = (ev) => { clearTimeout(guardia); chiudi(); ev.data.ok ? resolve(ev.data) : reject(new Error(ev.data.errore)); };
    w.onerror = (ev) => { clearTimeout(guardia); chiudi(); reject(new Error('Impossibile avviare il solver (rete assente?): ' + (ev.message || ''))); };
    w.postMessage({ lp, tempo });
  });
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
  const lp = scriviLP(m);
  const risposta = await (opzioni.risolvi || risolviNelBrowser)(lp, opzioni);
  if (!risposta.valori || !Object.keys(risposta.valori).length) throw new Error('Il solver non ha trovato nessun piano (' + (risposta.stato || 'sconosciuto') + ').');
  const sol = leggiSoluzione(m, risposta.valori, dati);
  return { ...sol, riepilogo: riepilogo(m, sol), stato: risposta.stato, modello: m };
}
