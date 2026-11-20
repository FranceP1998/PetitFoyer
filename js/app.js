import { creaBackend } from './data.js';
import { CONFIG } from './config.js';
import { renderGrid, righeLegenda, nomeMese, pad, eProtetta } from './grid.js';

const $ = (id) => document.getElementById(id);
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

// Simboli selezionabili nella finestra di modifica
const VOCI = [
  { kind: 'M', etichetta: 'M', nota: 'Mattina 7–15' },
  { kind: 'P', etichetta: 'P', nota: 'Pomeriggio 15–23' },
  { kind: 'N', etichetta: '⟋', nota: 'Notte (inizia oggi)' },
  { kind: 'R', etichetta: 'R', nota: 'Riposo obbligatorio' },
  { kind: 'RR', etichetta: 'R<sub>R</sub>', nota: 'Riposo richiesto' },
  { kind: 'F', etichetta: 'F', nota: 'Ferie' },
  { kind: 'FS', etichetta: '–', nota: 'Domenica in ferie' },
  { kind: 'PERM', etichetta: 'P', nota: 'Permesso' },
  { kind: 'SPESA', etichetta: '⊛', nota: 'Copertura spesa' },
  { kind: 'RB', etichetta: 'RB', nota: 'Recupero ore' },
];

const stato = { be: null, utente: null, y: 0, m: 0, dati: null, modifica: false, sblocchi: [] };
const valido = (s) => s.status === 'approved' && Date.now() - Date.parse(s.decided_at) < 24 * 3600 * 1000;
const NOMI_PROTETTI = { F: 'ferie', FS: 'domenica in ferie', PERM: 'permesso', RR: 'riposo richiesto', M: 'turno richiesto', P: 'turno richiesto', N: 'turno richiesto' };
const elencoProtetti = (kinds) => [...new Set(String(kinds || '').split(',').filter(Boolean).map((k) => NOMI_PROTETTI[k] || k))].join(', ');
const dataEstesa = (data) => { const d = new Date(data + 'T00:00:00'); return `${GIORNI[d.getDay()]} ${d.getDate()} ${nomeMese(d.getMonth() + 1).toLowerCase()}`; };
const isCoord = () => stato.utente?.role === 'coordinator';

function meseDaHash() {
  const mt = /^#(\d{4})-(\d{1,2})$/.exec(location.hash);
  if (mt) return { y: +mt[1], m: +mt[2] };
  const oggi = new Date();
  return { y: oggi.getFullYear(), m: oggi.getMonth() + 1 };
}

async function avvia() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  stato.be = await creaBackend();
  ({ y: stato.y, m: stato.m } = meseDaHash());
  if (stato.be.demo) {
    $('demo-banner').hidden = false;
    const sel = $('demo-ruolo');
    sel.value = (() => { try { return localStorage.getItem('turni-demo-ruolo'); } catch { return null; } })() || 'coordinator';
    sel.onchange = async () => { stato.be.cambiaRuoloDemo(sel.value); stato.utente = await stato.be.sessione(); stato.modifica = false; await mostra(); };
    $('demo-reset').onclick = () => stato.be.azzeraDemo();
    if (!location.hash) { stato.y = 2026; stato.m = 11; }          // il demo parte da novembre 2026
  }
  try { stato.utente = await stato.be.sessione(); } catch (e) { mostraAccesso(e.message); return; }
  if (!stato.utente) { mostraAccesso(); return; }
  await mostra();
}

function mostraAccesso(errore) {
  $('app').hidden = true; $('login').hidden = false;
  if (errore) { $('login-err').textContent = errore; $('login-err').hidden = false; }
  $('login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    $('login-err').hidden = true;
    try {
      stato.utente = await stato.be.accedi($('login-email').value.trim(), $('login-pass').value);
      $('login').hidden = true;
      await mostra();
    } catch (e) { $('login-err').textContent = e.message; $('login-err').hidden = false; }
  };
}

async function mostra() {
  $('login').hidden = true; $('app').hidden = false;
  document.body.classList.toggle('coord', isCoord());
  for (const b of document.querySelectorAll('.solo-coord')) b.hidden = !isCoord();
  $('utente').textContent = stato.utente.name;
  $('btn-esci').hidden = stato.be.demo;
  await carica();
}

async function carica() {
  $('titolo-mese').textContent = `${nomeMese(stato.m)} ${stato.y}`;
  try { history.replaceState(null, '', `#${stato.y}-${stato.m}`); } catch { /* ignora */ }
  try {
    stato.dati = await stato.be.caricaMese(stato.y, stato.m);
  } catch (e) { mostraMessaggio('Non riesco a caricare i dati: ' + e.message); return; }
  try { stato.sblocchi = await stato.be.elencaSblocchi(); } catch { stato.sblocchi = []; }
  disegna();
}

function mostraMessaggio(t) { const p = $('messaggio'); p.textContent = t || ''; p.hidden = !t; }

function disegna() {
  const { month, staff, shifts, events } = stato.dati;
  const pubblicato = month.status === 'published';
  const badge = $('badge-stato');
  badge.textContent = pubblicato ? 'Pubblicato' : 'Bozza';
  badge.className = 'badge ' + (pubblicato ? 'ok' : 'bozza');
  $('btn-pubblica').textContent = pubblicato ? 'Riporta in bozza' : 'Pubblica';
  $('btn-modifica').textContent = stato.modifica ? 'Fine modifiche' : 'Modifica';
  $('btn-modifica').classList.toggle('attivo', stato.modifica);

  $('f-servizio').textContent = CONFIG.SERVIZIO;
  $('f-mese').textContent = `${nomeMese(stato.m).toUpperCase()} ${stato.y}`;

  // gli operatori non vedono i mesi non pubblicati
  const nascosto = !isCoord() && !pubblicato;
  mostraMessaggio(nascosto
    ? 'Il piano di questo mese non è ancora stato pubblicato.'
    : (isCoord() && !pubblicato ? 'Bozza: gli operatori non la vedono finché non la pubblichi.' : ''));
  $('pagina').hidden = nascosto;
  disegnaConsensi();
  if (nascosto) return;

  $('legenda').innerHTML = righeLegenda(events, stato.y, stato.m).map((r) => `<li class="${r.cls}">${r.html}</li>`).join('');
  $('foglio').innerHTML = renderGrid({
    year: stato.y, month: stato.m, staff, shifts, events,
    editable: isCoord() && stato.modifica,
    evidenzia: stato.utente.staffId,
  });
  $('foglio').classList.toggle('modificabile', isCoord() && stato.modifica);

  const oss = month.notes || '';
  $('osservazioni-testo').textContent = oss;
  const ed = $('osservazioni-edit');
  ed.hidden = !(isCoord() && stato.modifica);
  $('osservazioni-testo').hidden = isCoord() && stato.modifica;
  ed.value = oss;
}

// ------------------------------------------------------------ navigazione
function vaiMese(delta) {
  let m = stato.m + delta, y = stato.y;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  stato.y = y; stato.m = m;
  carica();
}
$('prev').onclick = () => vaiMese(-1);
$('next').onclick = () => vaiMese(1);
$('btn-stampa').onclick = () => window.print();
$('btn-esci').onclick = async () => { await stato.be.esci(); stato.utente = null; mostraAccesso(); };
$('btn-modifica').onclick = () => { stato.modifica = !stato.modifica; disegna(); };
$('btn-pubblica').onclick = async () => {
  const pubblicato = stato.dati.month.status === 'published';
  if (!pubblicato && !confirm('Pubblicare il piano? Da questo momento gli operatori lo vedono.')) return;
  await stato.be.salvaMese(stato.y, stato.m, { status: pubblicato ? 'draft' : 'published' });
  await carica();
};
$('osservazioni-edit').onchange = async (ev) => { await stato.be.salvaMese(stato.y, stato.m, { notes: ev.target.value }); await carica(); };

// ------------------------------------------------------------ consenso dell'operatore
// Ferie, permessi e richieste accettate sono protette: la coordinatrice non può toglierle né
// cambiarle, salvo consenso dell'operatore (che accetta o rifiuta qui, nell'app).
function nomePersona(id) { return stato.dati.staff.find((s) => s.id === id)?.name || 'operatore'; }

function disegnaConsensi() {
  const box = $('consensi');
  const mio = stato.utente.staffId;
  let html = '';
  if (isCoord()) {
    const attesa = stato.sblocchi.filter((s) => s.status === 'pending');
    const ok = stato.sblocchi.filter(valido);
    for (const s of attesa) html += `<div class="consenso info">In attesa di <b>${nomePersona(s.staff_id)}</b> per la casella di ${dataEstesa(s.date)} (${elencoProtetti(s.kinds)}).</div>`;
    for (const s of ok) html += `<div class="consenso ok"><b>${nomePersona(s.staff_id)}</b> ha dato il consenso per ${dataEstesa(s.date)}: puoi modificare la casella entro 24 ore.</div>`;
  } else {
    const coord = stato.dati.staff.find((s) => s.role === 'coordinator')?.name || 'La coordinatrice';
    for (const s of stato.sblocchi.filter((x) => x.status === 'pending' && x.staff_id === mio)) {
      html += `<div class="consenso richiesta" role="alert">
        <p><b>${coord}</b> chiede di poter modificare la tua casella di <b>${dataEstesa(s.date)}</b> (${elencoProtetti(s.kinds)}).
        Se accetti, potrà cambiarla nelle prossime 24 ore. Se rifiuti, resta com'è.</p>
        <div class="consenso-azioni"><button class="primario" data-risp="${s.id}" data-ok="1">Accetta</button><button data-risp="${s.id}" data-ok="0">Rifiuta</button></div>
      </div>`;
    }
  }
  box.innerHTML = html;
  box.hidden = !html;
}
$('consensi').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-risp]'); if (!b) return;
  try { await stato.be.rispondiSblocco(isNaN(+b.dataset.risp) ? b.dataset.risp : +b.dataset.risp, b.dataset.ok === '1'); } catch (e) { alert(e.message); }
  await carica();
});

// ------------------------------------------------------------ modifica cella
let cellaCorrente = null;
$('foglio').addEventListener('click', (ev) => {
  if (!isCoord() || !stato.modifica) return;
  const td = ev.target.closest('td[data-staff]');
  if (!td) return;
  apriCella(+td.dataset.staff, td.dataset.date);
});

function apriCella(staffId, data) {
  const p = stato.dati.staff.find((s) => s.id === staffId);
  const esistenti = stato.dati.shifts.filter((s) => s.staff_id === staffId && s.date === data);
  const protette = esistenti.filter(eProtetta);
  const sblocco = stato.sblocchi.find((s) => s.staff_id === staffId && s.date === data && valido(s));
  const attesa = stato.sblocchi.find((s) => s.staff_id === staffId && s.date === data && s.status === 'pending');
  const bloccata = protette.length > 0 && !sblocco;
  cellaCorrente = { staffId, data, esistenti, bloccata, sblocco, protetti: new Set(protette.map((e) => e.kind)), scelti: new Set(esistenti.map((e) => e.kind)) };

  $('cella-titolo').textContent = `${p.name} — ${dataEstesa(data)}`;
  $('cella-richiesto').checked = esistenti.some((e) => e.requested && 'MPN'.includes(e.kind));
  $('cella-richiesto').disabled = bloccata && esistenti.some((e) => e.requested);

  const box = $('cella-chips');
  box.innerHTML = VOCI.map((v) => {
    const fissa = bloccata && cellaCorrente.protetti.has(v.kind);
    return `<button type="button" class="chip${fissa ? ' bloccato' : ''}" data-kind="${v.kind}" ${fissa ? 'disabled' : ''} title="${v.nota}"><span class="chip-sim">${v.etichetta}</span><span class="chip-nota">${v.nota}${fissa ? ' 🔒' : ''}</span></button>`;
  }).join('');
  const aggiorna = () => { for (const b of box.children) b.classList.toggle('on', cellaCorrente.scelti.has(b.dataset.kind)); };
  box.onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b || b.disabled) return;
    const k = b.dataset.kind;
    cellaCorrente.scelti.has(k) ? cellaCorrente.scelti.delete(k) : cellaCorrente.scelti.add(k);
    aggiorna();
  };
  aggiorna();

  // pannello del consenso
  const pann = $('cella-blocco'), testo = $('cella-blocco-testo'), btn = $('cella-consenso');
  pann.hidden = !(bloccata || sblocco);
  if (bloccata) {
    testo.textContent = `Questa casella contiene ${elencoProtetti(protette.map((e) => e.kind).join(','))} e non si può modificare né cancellare senza il consenso di ${p.name}.`;
    btn.hidden = false;
    btn.disabled = !!attesa;
    btn.textContent = attesa ? `In attesa della risposta di ${p.name}` : `Chiedi il consenso a ${p.name}`;
    btn.onclick = async () => {
      try { await stato.be.chiediSblocco(staffId, data); } catch (e) { alert(e.message); return; }
      await carica(); apriCella(staffId, data);
    };
  } else if (sblocco) {
    testo.textContent = `${p.name} ha dato il consenso: puoi modificare questa casella per 24 ore dal momento del consenso.`;
    btn.hidden = true;
  }
  $('cella-svuota').disabled = bloccata;
  if (!$('dlg-cella').open) $('dlg-cella').showModal();
}
$('cella-annulla').onclick = () => $('dlg-cella').close();
$('cella-svuota').onclick = async () => { await salvaCella([]); };
$('form-cella').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const c = cellaCorrente;
  const rich = $('cella-richiesto').checked;
  const voci = [...c.scelti].map((kind) => {
    if (c.bloccata && c.protetti.has(kind)) {                      // voce protetta: resta identica
      return { kind, requested: !!c.esistenti.find((e) => e.kind === kind)?.requested };
    }
    return { kind, requested: rich && 'MPN'.includes(kind) };
  });
  await salvaCella(voci);
});
async function salvaCella(voci) {
  const c = cellaCorrente;
  try {
    await stato.be.impostaCella(c.staffId, c.data, voci);
    if (c.sblocco) await stato.be.chiudiSblocco(c.staffId, c.data, 'used');
    $('dlg-cella').close();
    await carica();
  } catch (e) { alert('Non sono riuscito a salvare: ' + e.message); }
}

// ------------------------------------------------------------ eventi del mese
$('btn-eventi').onclick = () => { elencaEventi(); $('ev-date').value = `${stato.y}-${pad(stato.m)}-01`; $('dlg-eventi').showModal(); };
function elencaEventi() {
  const delMese = stato.dati.events.filter((e) => e.date.startsWith(`${stato.y}-${pad(stato.m)}-`)).sort((a, b) => a.date.localeCompare(b.date));
  const nomi = { collettivo: 'Collettivo', spesa: 'Copertura spesa', altro: 'Altro' };
  $('eventi-lista').innerHTML = delMese.length
    ? delMese.map((e) => `<li><span>${e.date.slice(8, 10)}/${e.date.slice(5, 7)} · ${nomi[e.kind]} ${e.start_time ? e.start_time.slice(0, 5) + '–' + (e.end_time || '').slice(0, 5) : ''} ${e.label || ''}</span><button type="button" class="link" data-del="${e.id}">Elimina</button></li>`).join('')
    : '<li class="muted">Nessun evento.</li>';
}
$('eventi-lista').onclick = async (ev) => {
  const id = ev.target.dataset?.del; if (!id) return;
  await stato.be.eliminaEvento(isNaN(+id) ? id : +id);
  await carica(); elencaEventi();
};
$('ev-aggiungi').onclick = async () => {
  const date = $('ev-date').value; if (!date) return;
  await stato.be.aggiungiEvento({
    date, kind: $('ev-kind').value, label: $('ev-label').value.trim(),
    start_time: $('ev-start').value || null, end_time: $('ev-end').value || null,
  });
  $('ev-label').value = '';
  await carica(); elencaEventi();
};

avvia().catch((e) => mostraMessaggio('Errore: ' + e.message));
