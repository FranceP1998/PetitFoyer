// Strato dati: due "backend" con la stessa interfaccia.
//  - demo:     dati in memoria (+ localStorage), nessun account. Serve per provare l'app.
//  - supabase: dati veri, login e ruoli.
import { CONFIG } from './config.js';
import { DEMO } from './demo-data.js';
import { iso, pad, giorniDelMese, meseDopo, PROTETTI } from './grid.js';
import { giorniMalattia } from './mutua.js';
import { controllaRegole, controllaFerie, giorniAssenza, MAX_RICHIESTE, richiesteAperte, mesiConRichieste } from './richieste.js';

export const isDemo = !(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

// intervallo di date da caricare per un mese: ultimo giorno del mese prima (serve per la
// sbarra della notte che finisce il giorno 1) fino al 1° del mese dopo (ultima colonna)
function intervallo(y, m) {
  const prec = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const dopo = meseDopo(y, m);
  return { da: iso(prec.y, prec.m, giorniDelMese(prec.y, prec.m)), a: iso(dopo.y, dopo.m, 1) };
}

// come si scrive una richiesta nelle notifiche: "di riposo del 15/12", "di ferie dal 10/12 al 17/12"
const descrRichiesta = (r) => {
  const g = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const t = { RR: 'di riposo', M: 'della mattina', P: 'del pomeriggio', N: 'della notte', F: 'di ferie', PERM: 'di permesso' }[r.kind];
  return `${t} ${r.last_date && r.last_date > r.date ? `dal ${g(r.date)} al ${g(r.last_date)}` : `del ${g(r.date)}`}`;
};
const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// ------------------------------------------------------------------ DEMO
function backendDemo() {
  const KEY = 'turni-demo-v3';
  const leggi = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const scrivi = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } };
  let db;
  try { db = JSON.parse(leggi(KEY)); } catch { db = null; }
  if (!db) db = JSON.parse(JSON.stringify(DEMO));
  const salva = () => scrivi(KEY, JSON.stringify(db));
  let ruolo = leggi('turni-demo-ruolo') || 'coordinator';
  db.unlocks = db.unlocks || [];
  const sbloccoValido = (staffId, data) => db.unlocks.some((s) => s.staff_id === staffId && s.date === data && s.status === 'approved' && Date.now() - Date.parse(s.decided_at) < 24 * 3600 * 1000);
  let nextId = Math.max(1000, ...db.shifts.map((s) => s.id || 0), ...db.events.map((e) => e.id || 0)) + 1;

  const utente = () => {
    const cerca = ruolo === 'coordinator' ? (s) => s.role === 'coordinator' : (s) => s.name === 'Domenico';
    const s = db.staff.find(cerca);
    return { staffId: s.id, name: s.name, role: s.role };
  };
  // regole sul periodo (come nel database)
  const controllaPeriodo = (da, a) => {
    if (!da || !a) throw new Error('Scrivi il primo e l\'ultimo giorno.');
    if (a < da) throw new Error('L\'ultimo giorno non può essere prima del primo.');
    if ((Date.parse(a) - Date.parse(da)) / 86400000 > 59) throw new Error('Il periodo è troppo lungo (massimo 60 giorni): per periodi più lunghi avvisa Marie.');
  };
  // nel demo un mese è pubblicato se lo dice il suo stato (il 1° giorno conta per il mese prima)
  const meseDemoPubblicato = (data) => {
    const stato = (y, m) => (db.monthsState?.[`${y}-${m}`] || (y === DEMO.month.year && m === DEMO.month.month ? DEMO.month : { status: 'draft' })).status === 'published';
    const [y, m, g] = data.split('-').map(Number);
    return stato(y, m) || (g === 1 && stato(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1));
  };
  return {
    demo: true,
    async sessione() { return utente(); },
    async accedi() { return utente(); },
    async esci() { /* niente */ },
    async servePassword() { return false; },
    // --- gestione personale (demo: tutto in locale)
    async elencoPersonale() {
      return [...db.staff].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((p) => ({ email: p.email || `${p.name.toLowerCase()}@esempio.it`, contract_hours: null, start_date: null, end_date: null, ha_accesso: true, ...p }));
    },
    async salvaPersona(p) {
      const campi = { name: p.name, email: p.email || null, fixed_pattern: !!p.fixed_pattern, contract_hours: p.contract_hours ?? null, start_date: p.start_date || null, end_date: p.end_date || null, sort_order: p.sort_order };
      if (p.id) { Object.assign(db.staff.find((x) => x.id === p.id), campi); }
      else { db.staff.push({ id: Math.max(0, ...db.staff.map((x) => x.id)) + 1, role: 'operator', active: true, ...campi }); }
      salva();
    },
    async ordinaPersona(id, ordine) { db.staff.find((x) => x.id === id).sort_order = ordine; salva(); },
    async eliminaPersona(id) {
      if (db.shifts.some((s) => s.staff_id === id)) throw new Error('Una persona con turni non si elimina: imposta la data di fine servizio.');
      db.staff = db.staff.filter((x) => x.id !== id); salva();
    },
    // --- malattia comunicata dall'operatore (demo: tutto in locale)
    async anteprimaMalattia(da, a) {
      controllaPeriodo(da, a);
      const giorni = giorniMalattia(db.shifts, utente().staffId, da, a);
      const pub = giorni.filter((g) => meseDemoPubblicato(g.date));
      return { giorni: pub, giorni_bozza: giorni.length - pub.length };
    },
    async comunicaMalattia(da, a) {
      controllaPeriodo(da, a);
      const u = utente();
      const giorni = giorniMalattia(db.shifts, u.staffId, da, a);
      if (!giorni.length) return { id: null, giorni };
      for (const g of giorni) db.shifts.push({ id: nextId++, staff_id: u.staffId, date: g.date, kind: 'MU', requested: false, start_time: null, end_time: null });
      db.sick = db.sick || [];
      const rep = { id: nextId++, staff_id: u.staffId, first_day: da, last_day: a, days: giorni, status: 'open', created_at: new Date().toISOString() };
      db.sick.push(rep);
      db.notifiche = db.notifiche || [];
      for (const c of db.staff.filter((x) => x.role === 'coordinator' && x.id !== u.staffId)) {
        db.notifiche.push({ id: nextId++, staff_id: c.id, kind: 'malattia', created_at: new Date().toISOString(), read_at: null,
          text: `${u.name} ha comunicato malattia dal ${da.slice(8, 10)}/${da.slice(5, 7)} al ${a.slice(8, 10)}/${a.slice(5, 7)}: ${giorni.length} ${giorni.length === 1 ? 'turno da coprire.' : 'turni da coprire.'} Scegli le coperture.` });
      }
      salva();
      return { id: rep.id, giorni };
    },
    async elencaMalattie() { return (db.sick || []).filter((r) => r.status === 'open'); },
    async chiudiMalattia(id) { const r = (db.sick || []).find((x) => x.id === id); if (r) { r.status = 'closed'; salva(); } },
    // applica la copertura di un giorno di malattia: orari ai colleghi vicini e/o altre persone in copertura (COP);
    // il giorno risulta "fatto" e, a giorni finiti, la segnalazione si chiude da sola
    async applicaCopertura(report, giorno, voci) {
      db.notifiche = db.notifiche || [];
      const gm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
      for (const v of voci) {
        if (!v.inizio || !v.fine || v.inizio === v.fine) throw new Error('Indica l\'ora di inizio e di fine.');
        if (db.shifts.some((s) => s.staff_id === v.staffId && s.date === v.date && s.kind === 'MU')) throw new Error('Una persona in malattia non può fare la copertura.');
      }
      for (const v of voci) {
        if (v.kind === 'COP') {
          const r = db.shifts.find((s) => s.staff_id === v.staffId && s.date === v.date && s.kind === 'COP');
          if (r) { r.start_time = v.inizio; r.end_time = v.fine; }
          else db.shifts.push({ id: nextId++, staff_id: v.staffId, date: v.date, kind: 'COP', requested: false, start_time: v.inizio, end_time: v.fine });
          db.notifiche.push({ id: nextId++, staff_id: v.staffId, kind: 'copertura', created_at: new Date().toISOString(), read_at: null,
            text: `Ti è stata assegnata una copertura il ${gm(v.date)} dalle ${v.inizio} alle ${v.fine}. Controlla il foglio.` });
        } else {
          const r = db.shifts.find((s) => s.staff_id === v.staffId && s.date === v.date && s.kind === v.kind);
          if (!r) throw new Error('Turno non trovato.');
          r.start_time = v.inizio; r.end_time = v.fine;
          db.notifiche.push({ id: nextId++, staff_id: v.staffId, kind: 'copertura', created_at: new Date().toISOString(), read_at: null,
            text: `Il tuo turno ${v.kind} del ${gm(v.date)} è stato modificato per una copertura: orario ${v.inizio}–${v.fine}. Controlla il foglio.` });
        }
      }
      const rep = report ? (db.sick || []).find((x) => x.id === report) : null;
      if (rep && giorno) {
        for (const d of rep.days) if (d.date === giorno) d.done = true;
        if (rep.days.every((d) => d.done)) rep.status = 'closed';
      }
      salva();
    },
    async elencaNotifiche() { const u = utente(); return (db.notifiche || []).filter((n) => n.staff_id === u.staffId && !n.read_at).sort((x, y) => y.created_at.localeCompare(x.created_at)); },
    async segnaNotificaLetta(id) { const n = (db.notifiche || []).find((x) => x.id === id && x.staff_id === utente().staffId); if (n) { n.read_at = new Date().toISOString(); salva(); } },
    // --- richieste di riposo o di turno (demo: le regole sono in js/richieste.js, nell'app vera nel database)
    async mesiRichieste() { return mesiConRichieste(); },
    async elencaRichieste(y, m) {
      const pre = `${y}-${pad(m)}-`;
      const fineMese = `${pre}${pad(new Date(y, m, 0).getDate())}`, inizioMese = `${pre}01`;
      return (db.richieste || []).filter((r) => r.date <= fineMese && (r.last_date || r.date) >= inizioMese && r.status !== 'cancelled')
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    },
    async elaboraScadenze() { return 0; },   // demo: nessuna scadenza automatica
    async inviaRichiesta(date, kind, conferma = false, fine = null) {
      const u = utente(); db.richieste = db.richieste || [];
      const assenza = ['F', 'PERM'].includes(kind), ultimo = assenza ? (fine || date) : null;
      const y = +date.slice(0, 4), m = +date.slice(5, 7);
      const msgChiuse = 'Le richieste per questo mese non sono aperte: si possono fare dal 1 ottobre dell\'anno prima fino al 20 del mese prima.';
      if (!richiesteAperte(y, m) || (ultimo && !richiesteAperte(+ultimo.slice(0, 4), +ultimo.slice(5, 7)))) throw new Error(msgChiuse);
      let avvisi;
      if (assenza) avvisi = controllaFerie(db, u.staffId, date, ultimo);
      else {
        const pre = `${y}-${pad(m)}-`;
        if (db.richieste.filter((r) => r.staff_id === u.staffId && r.date.startsWith(pre) && ['pending', 'accepted'].includes(r.status) && ['RR', 'M', 'P', 'N'].includes(r.kind)).length >= MAX_RICHIESTE) throw new Error('Hai già fatto 3 richieste per questo mese.');
        avvisi = controllaRegole(db, u.staffId, date, kind);
      }
      if (avvisi.length && !conferma) throw new Error('[avviso] ' + avvisi.join('\n'));
      const r = { id: nextId++, staff_id: u.staffId, date, last_date: ultimo, kind, status: 'pending', created_at: new Date().toISOString(), avvisi, motivo: null };
      db.richieste.push(r);
      db.notifiche = db.notifiche || [];
      for (const c of db.staff.filter((x) => x.role === 'coordinator' && x.id !== u.staffId)) {
        db.notifiche.push({ id: nextId++, staff_id: c.id, kind: 'richiesta', created_at: new Date().toISOString(), read_at: null,
          text: `${u.name} ha inviato una richiesta ${descrRichiesta(r)}.${avvisi.length ? ' Richiesta critica: ' + avvisi.join(' ') : ''}` });
      }
      salva(); return r.id;
    },
    async annullaRichiesta(id) {
      const r = (db.richieste || []).find((x) => x.id === id && x.status === 'pending' && x.staff_id === utente().staffId);
      if (r) { r.status = 'cancelled'; salva(); }
    },
    async rispondiRichiesta(id, accetta, motivo = '') {
      const r = (db.richieste || []).find((x) => x.id === id && x.status === 'pending');
      if (!r) throw new Error('Richiesta non trovata o già decisa.');
      const mot = (motivo || '').trim();
      if (!mot && (!accetta || (r.avvisi || []).length)) throw new Error('Scrivi la motivazione.');
      if (accetta) {
        const giorni = ['F', 'PERM'].includes(r.kind) ? giorniAssenza(r.date, r.last_date || r.date, r.kind, db.staff.find((x) => x.id === r.staff_id)) : [{ date: r.date, kind: r.kind }];
        const occupati = giorni.filter((g) => db.shifts.some((s) => s.staff_id === r.staff_id && s.date === g.date && ['M', 'P', 'N', 'RR', 'F', 'FS', 'PERM', 'T1018', 'MU'].includes(s.kind)));
        if (occupati.length) throw new Error(`In ${occupati.length > 1 ? 'questi giorni' : 'questo giorno'} c'è già un altro turno o un'assenza: ${occupati.map((g) => g.date.slice(8, 10) + '/' + g.date.slice(5, 7)).join(', ')}.`);
        db.shifts = db.shifts.filter((s) => !(['F', 'PERM'].includes(r.kind) && s.staff_id === r.staff_id && s.kind === 'R' && s.date >= r.date && s.date <= (r.last_date || r.date)));
        for (const g of giorni) db.shifts.push({ id: nextId++, staff_id: r.staff_id, date: g.date, kind: g.kind, requested: g.kind !== 'F' && g.kind !== 'FS' && g.kind !== 'PERM' && ['M', 'P', 'N'].includes(g.kind), start_time: null, end_time: null });
      }
      r.status = accetta ? 'accepted' : 'rejected'; r.motivo = mot || null;
      db.notifiche = db.notifiche || [];
      db.notifiche.push({ id: nextId++, staff_id: r.staff_id, kind: 'richiesta', created_at: new Date().toISOString(), read_at: null,
        text: `La tua richiesta ${descrRichiesta(r)} è stata ${accetta ? 'accettata.' : 'rifiutata.'}${mot ? ' Motivo: ' + mot : ''}` });
      salva();
    },
    cambiaRuoloDemo(r) { ruolo = r; scrivi('turni-demo-ruolo', r); },
    async caricaMese(y, m) {
      const { da, a } = intervallo(y, m);
      const mese = db.months?.find?.((x) => x.year === y && x.month === m) ||
        (y === DEMO.month.year && m === DEMO.month.month ? DEMO.month : { year: y, month: m, status: 'draft', notes: '' });
      return {
        month: db.monthsState?.[`${y}-${m}`] || mese,
        staff: db.staff,
        shifts: db.shifts.filter((s) => s.date >= da && s.date <= a
          && (utente().role === 'coordinator' || (db.monthsState?.[`${y}-${m}`] || mese).status === 'published'
              || ['RR', 'F', 'FS', 'PERM'].includes(s.kind) || s.requested)),
        events: db.events.filter((e) => e.date >= da && e.date <= a),
      };
    },
    async impostaCella(staffId, data, voci) {
      const esistenti = db.shifts.filter((s) => s.staff_id === staffId && s.date === data);
      const firma = (v) => `${!!v.requested}|${(v.start_time || '').slice(0, 5)}|${(v.end_time || '').slice(0, 5)}`;
      const nuovo = new Map(voci.map((v) => [v.kind, firma(v)]));
      // da togliere: voci sparite o con la spunta "richiesto" / gli orari cambiati
      const daTogliere = esistenti.filter((e) => !nuovo.has(e.kind) || nuovo.get(e.kind) !== firma(e));
      if (daTogliere.some((e) => PROTETTI.includes(e.kind) || e.requested) && !sbloccoValido(staffId, data)) {
        throw new Error('Casella protetta (ferie, permesso o richiesta accettata): serve il consenso dell\'operatore.');
      }
      const tolti = new Set(daTogliere);
      db.shifts = db.shifts.filter((s) => !tolti.has(s));
      const rimasti = new Set(db.shifts.filter((s) => s.staff_id === staffId && s.date === data).map((s) => s.kind));
      for (const v of voci) if (!rimasti.has(v.kind)) db.shifts.push({ id: nextId++, staff_id: staffId, date: data, kind: v.kind, requested: !!v.requested, start_time: v.start_time || null, end_time: v.end_time || null });
      salva();
    },
    async impostaOrario(staffId, data, kind, inizio, fine) {
      const r = db.shifts.find((s) => s.staff_id === staffId && s.date === data && s.kind === kind);
      if (!r) throw new Error('Turno non trovato.');
      r.start_time = inizio; r.end_time = fine; salva();
    },
    // --- consenso dell'operatore per modificare caselle protette ---
    async elencaSblocchi() {
      const u = utente();
      return db.unlocks.filter((s) => (u.role === 'coordinator' ? ['pending', 'approved'].includes(s.status) : s.staff_id === u.staffId && s.status === 'pending'));
    },
    async chiediSblocco(staffId, data) {
      const gia = db.unlocks.find((s) => s.staff_id === staffId && s.date === data && s.status === 'pending');
      if (gia) return gia.id;
      const kinds = db.shifts.filter((s) => s.staff_id === staffId && s.date === data && (PROTETTI.includes(s.kind) || s.requested)).map((s) => s.kind).sort().join(',');
      const r = { id: nextId++, staff_id: staffId, date: data, kinds, status: 'pending', created_at: new Date().toISOString(), decided_at: null };
      db.unlocks.push(r); salva(); return r.id;
    },
    async rispondiSblocco(id, accetta) {
      const r = db.unlocks.find((s) => s.id === id && s.status === 'pending');
      if (!r) throw new Error('Richiesta non trovata o già decisa.');
      r.status = accetta ? 'approved' : 'rejected'; r.decided_at = new Date().toISOString(); salva();
    },
    async chiudiSblocco(staffId, data, stato) {
      for (const r of db.unlocks) if (r.staff_id === staffId && r.date === data && ['pending', 'approved'].includes(r.status)) r.status = stato;
      salva();
    },
    async salvaMese(y, m, patch) {
      db.monthsState = db.monthsState || {};
      const cur = (await this.caricaMese(y, m)).month;
      db.monthsState[`${y}-${m}`] = { ...cur, ...patch };
      salva();
    },
    async aggiungiEvento(e) { db.events.push({ id: nextId++, ...e }); salva(); },
    async eliminaEvento(id) { db.events = db.events.filter((e) => e.id !== id); salva(); },
    async azzeraDemo() { try { localStorage.removeItem(KEY); } catch { /* ignora */ } location.reload(); },
  };
}

// ------------------------------------------------------------------ SUPABASE
function traduciErrorePassword(m) {
  if (/same|different from the old/i.test(m)) return 'La nuova password deve essere diversa dalla precedente.';
  if (/weak|short|characters|at least/i.test(m)) return 'Password troppo debole: usane una più lunga.';
  if (/nonce|reauth|expired|invalid/i.test(m)) return 'Codice non valido o scaduto.';
  return m;
}

async function backendSupabase() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const errore = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

  async function persona() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const r = await sb.from('staff').select('id,name,role').eq('user_id', session.user.id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data) throw new Error('Il tuo account non è ancora collegato a una persona. Chiedi a Marie o a chi ha configurato l\'app.');
    return { staffId: r.data.id, name: r.data.name, role: r.data.role };
  }

  return {
    demo: false,
    sessione: persona,
    async accedi(email, password) {
      const r = await sb.auth.signInWithPassword({ email, password });
      if (r.error) throw new Error('Email o password non corrette.');
      return persona();
    },
    async esci() { await sb.auth.signOut(); },

    // ---- primo accesso / password dimenticata: codice via email, poi scelta della password
    async servePassword() {
      const { data: { session } } = await sb.auth.getSession();
      return !!session && !session.user.user_metadata?.password_set;
    },
    async richiediCodice(email) {
      const r = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (r.error) {
        const m = r.error.message || '';
        if (/rate|seconds|too many/i.test(m)) throw new Error('Hai chiesto troppi codici: aspetta un minuto e riprova.');
        if (/database error|not allowed|abilitat/i.test(m)) throw new Error('Questo indirizzo email non è abilitato. Chiedi a Marie di aggiungerti.');
        throw new Error('Non riesco a inviare il codice: ' + m);
      }
    },
    async verificaCodice(email, codice) {
      const r = await sb.auth.verifyOtp({ email, token: codice, type: 'email' });
      if (r.error) throw new Error('Codice non valido o scaduto. Riprova o chiedine uno nuovo.');
    },
    async impostaPassword(password) {
      const r = await sb.auth.updateUser({ password, data: { password_set: true } });
      if (r.error) throw new Error(traduciErrorePassword(r.error.message));
      return persona();
    },
    // ---- cambio password da dentro l'app (serve un codice ricevuto per email)
    async codicePerCambio() {
      const r = await sb.auth.reauthenticate();
      if (r.error) throw new Error('Non riesco a inviare il codice: ' + r.error.message);
    },
    async cambiaPassword(password, codice) {
      const r = await sb.auth.updateUser({ password, nonce: codice });
      if (r.error) throw new Error(traduciErrorePassword(r.error.message));
    },
    // ---- gestione personale (solo coordinatrice: lo garantisce il database)
    async elencoPersonale() { return errore(await sb.rpc('elenco_personale')); },
    async salvaPersona(p) {
      const campi = { name: p.name, email: p.email || null, fixed_pattern: !!p.fixed_pattern, contract_hours: p.contract_hours ?? null, start_date: p.start_date || null, end_date: p.end_date || null };
      if (p.id) {
        if (!p.emailModificabile) delete campi.email;
        errore(await sb.from('staff').update(campi).eq('id', p.id));
      } else {
        errore(await sb.from('staff').insert({ ...campi, role: 'operator', sort_order: p.sort_order }));
      }
    },
    async ordinaPersona(id, ordine) { errore(await sb.from('staff').update({ sort_order: ordine }).eq('id', id)); },
    async eliminaPersona(id) { errore(await sb.from('staff').delete().eq('id', id)); },
    async caricaMese(y, m) {
      const { da, a } = intervallo(y, m);
      const [staff, shifts, events, mese] = await Promise.all([
        sb.from('staff').select('id,name,role,sort_order,fixed_pattern,active,start_date,end_date,senza_weekend').then(errore),
        sb.from('shifts').select('id,staff_id,date,kind,requested,start_time,end_time').gte('date', da).lte('date', a).then(errore),
        sb.from('events').select('id,date,kind,label,start_time,end_time').gte('date', da).lte('date', a).then(errore),
        sb.from('months').select('year,month,status,notes').eq('year', y).eq('month', m).maybeSingle().then(errore),
      ]);
      return { staff, shifts, events, month: mese || { year: y, month: m, status: 'draft', notes: '' } };
    },
    async impostaCella(staffId, data, voci) {
      const esistenti = errore(await sb.from('shifts').select('id,kind,requested,start_time,end_time').eq('staff_id', staffId).eq('date', data));
      const firma = (v) => `${!!v.requested}|${(v.start_time || '').slice(0, 5)}|${(v.end_time || '').slice(0, 5)}`;
      const nuovo = new Map(voci.map((v) => [v.kind, firma(v)]));
      const daTogliere = esistenti.filter((e) => !nuovo.has(e.kind) || nuovo.get(e.kind) !== firma(e));
      if (daTogliere.length) {
        // se la casella è protetta e manca il consenso, il database rifiuta e restituisce l'errore
        errore(await sb.from('shifts').delete().in('id', daTogliere.map((e) => e.id)));
      }
      const tolti = new Set(daTogliere.map((e) => e.id));
      const rimasti = new Set(esistenti.filter((e) => !tolti.has(e.id)).map((e) => e.kind));
      const daAggiungere = voci.filter((v) => !rimasti.has(v.kind));
      if (daAggiungere.length) {
        errore(await sb.from('shifts').insert(daAggiungere.map((v) => ({ staff_id: staffId, date: data, kind: v.kind, requested: !!v.requested, start_time: v.start_time || null, end_time: v.end_time || null }))));
      }
    },
    async impostaOrario(staffId, data, kind, inizio, fine) {
      errore(await sb.from('shifts').update({ start_time: inizio, end_time: fine }).eq('staff_id', staffId).eq('date', data).eq('kind', kind));
    },
    // --- consenso dell'operatore per modificare caselle protette ---
    async elencaSblocchi() {
      const r = errore(await sb.from('unlocks').select('id,staff_id,date,kinds,status,created_at,decided_at').in('status', ['pending', 'approved']));
      return r;
    },
    async chiediSblocco(staffId, data) { return errore(await sb.rpc('chiedi_sblocco', { p_staff: staffId, p_date: data })); },
    async rispondiSblocco(id, accetta) { errore(await sb.rpc('rispondi_sblocco', { p_id: id, p_accetta: accetta })); },
    async chiudiSblocco(staffId, data, stato) { errore(await sb.rpc('chiudi_sblocco', { p_staff: staffId, p_date: data, p_nuovo_stato: stato })); },
    async salvaMese(y, m, patch) {
      const row = { year: y, month: m, ...patch };
      if (patch.status === 'published') row.published_at = new Date().toISOString();
      errore(await sb.from('months').upsert(row, { onConflict: 'year,month' }));
    },
    // ---- malattia comunicata dall'operatore (il database applica le regole e avvisa Marie)
    async anteprimaMalattia(da, a) { return errore(await sb.rpc('anteprima_malattia', { p_from: da, p_to: a })); },
    async comunicaMalattia(da, a) { return errore(await sb.rpc('comunica_malattia', { p_from: da, p_to: a })); },
    async elencaMalattie() { return errore(await sb.from('sick_reports').select('id,staff_id,first_day,last_day,days,status,created_at').eq('status', 'open').order('created_at')); },
    async chiudiMalattia(id) { errore(await sb.rpc('chiudi_malattia', { p_id: id })); },
    async applicaCopertura(report, giorno, voci) {
      errore(await sb.rpc('applica_copertura', {
        p_report: report || null, p_giorno: giorno || null,
        p_voci: voci.map((v) => ({ staff: v.staffId, date: v.date, kind: v.kind, start: v.inizio, end: v.fine })),
      }));
    },
    // ---- notifiche nell'app
    async elencaNotifiche() { return errore(await sb.from('notifications').select('id,kind,text,created_at').is('read_at', null).order('created_at', { ascending: false })); },
    async segnaNotificaLetta(id) { errore(await sb.rpc('segna_notifica_letta', { p_id: id })); },
    // ---- richieste di riposo o di turno (le regole le applica il database)
    async mesiRichieste() { return errore(await sb.rpc('mesi_richieste')); },
    async elencaRichieste(y, m) {
      const dopo = meseDopo(y, m), d0 = iso(y, m, 1), d1 = iso(dopo.y, dopo.m, 1);
      // riposi e turni di quel mese + ferie e permessi che lo toccano (anche se cominciano prima o finiscono dopo)
      return errore(await sb.from('requests').select('id,staff_id,date,last_date,kind,status,created_at,avvisi,motivo')
        .lt('date', d1).or(`date.gte.${d0},last_date.gte.${d0}`).neq('status', 'cancelled').order('date').order('id'));
    },
    async elaboraScadenze() { return errore(await sb.rpc('elabora_scadenze')); },
    async inviaRichiesta(date, kind, conferma = false, fine = null) { return errore(await sb.rpc('invia_richiesta', { p_date: date, p_kind: kind, p_conferma: conferma, p_fine: fine || null })); },
    async annullaRichiesta(id) { errore(await sb.rpc('annulla_richiesta', { p_id: id })); },
    async rispondiRichiesta(id, accetta, motivo = '') { errore(await sb.rpc('rispondi_richiesta', { p_id: id, p_accetta: accetta, p_motivo: motivo || null })); },
    async aggiungiEvento(e) { errore(await sb.from('events').insert(e)); },
    async eliminaEvento(id) { errore(await sb.from('events').delete().eq('id', id)); },
  };
}

export async function creaBackend() {
  return isDemo ? backendDemo() : backendSupabase();
}
