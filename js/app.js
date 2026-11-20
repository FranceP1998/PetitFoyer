import { creaBackend } from './data.js';
import { CONFIG } from './config.js';
import { renderGrid, righeLegenda, nomeMese, pad, eProtetta, tracciaNotti } from './grid.js';
import { creaPdf, nomeFilePdf } from './pdf.js';
import { proponiCopertura } from './mutua.js';
import { etichettaScostamento } from './cella.js';

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
  { kind: 'FS', etichetta: '–', nota: 'Domenica dentro ferie o permessi' },
  { kind: 'PERM', etichetta: 'P<sub>R</sub>', nota: 'Permesso' },
  { kind: 'SPESA', etichetta: '⊛', nota: 'Copertura spesa' },
  { kind: 'T1018', etichetta: '10·18', nota: 'Turno 10–18' },
  { kind: 'COP', etichetta: '◯', nota: 'Copertura (orari liberi)' },
  { kind: 'MU', etichetta: 'MU', nota: 'Malattia (mutua): tieni selezionato il suo turno' },
  { kind: 'RB', etichetta: 'RB', nota: 'Recupero ore' },
];

// turni principali: in un giorno se ne può avere uno solo (la copertura, la spesa, il recupero ore e la malattia si aggiungono)
const ESCLUSIVI = ['M', 'P', 'N', 'R', 'RR', 'F', 'FS', 'PERM', 'T1018'];
// la malattia (MU) si mette su un turno, sul 10-18, su una copertura, sulla spesa o sul recupero ore:
// non ha senso con ferie, riposi, riposi richiesti e permessi
const PER_MALATTIA = ['M', 'P', 'N', 'T1018', 'COP', 'SPESA', 'RB'];
const SENZA_MALATTIA = ['R', 'RR', 'F', 'FS', 'PERM'];

const stato = { be: null, utente: null, y: 0, m: 0, dati: null, modifica: false, sblocchi: [] };
const valido = (s) => s.status === 'approved' && Date.now() - Date.parse(s.decided_at) < 24 * 3600 * 1000;
const NOMI_PROTETTI = { F: 'ferie', FS: 'domenica dentro ferie o permessi', PERM: 'permesso', RR: 'riposo richiesto', M: 'turno richiesto', P: 'turno richiesto', N: 'turno richiesto' };
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
  try {
    if (await stato.be.servePassword()) { mostraAccesso('password'); return; }   // codice già confermato, manca la password
    stato.utente = await stato.be.sessione();
  } catch (e) { mostraAccesso('accesso', e.message); return; }
  if (!stato.utente) { mostraAccesso(); return; }
  await mostra();
}

// ------------------------------------------------------------ accesso
const PASSI = ['f-accesso', 'f-email', 'f-codice', 'f-password'];
let emailPrimo = '';
function passo(id, errore, ok) {
  $('app').hidden = true; $('login').hidden = false;
  for (const p of PASSI) $(p).hidden = p !== id;
  $('login-err').textContent = errore || ''; $('login-err').hidden = !errore;
  $('login-ok').textContent = ok || ''; $('login-ok').hidden = !ok;
}
const messaggio = (e) => e?.message || String(e);
function mostraAccesso(quale = 'accesso', errore) {
  passo(quale === 'password' ? 'f-password' : 'f-accesso', errore);
}
async function entra() { $('login').hidden = true; await mostra(); }
$('f-accesso').onsubmit = async (ev) => {
  ev.preventDefault(); passo('f-accesso');
  try {
    stato.utente = await stato.be.accedi($('login-email').value.trim(), $('login-pass').value);
    $('login-pass').value = '';
    await entra();
  } catch (e) { passo('f-accesso', messaggio(e)); }
};
$('vai-primo').onclick = () => { $('primo-email').value = $('login-email').value; passo('f-email'); };
for (const b of document.querySelectorAll('[data-torna]')) b.onclick = () => passo('f-accesso');
async function inviaCodice(ev) {
  ev?.preventDefault();
  emailPrimo = $('primo-email').value.trim().toLowerCase() || emailPrimo;
  try {
    await stato.be.richiediCodice(emailPrimo);
    $('codice-testo').textContent = `Ho inviato un codice a ${emailPrimo}. Controlla la posta (anche lo spam) e scrivilo qui sotto.`;
    $('primo-codice').value = '';
    passo('f-codice', '', ev ? '' : 'Nuovo codice inviato.');
  } catch (e) { passo(ev ? 'f-email' : 'f-codice', messaggio(e)); }
}
$('f-email').onsubmit = inviaCodice;
$('codice-richiedi').onclick = () => inviaCodice(null);
$('f-codice').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await stato.be.verificaCodice(emailPrimo, $('primo-codice').value.trim());
    $('pw1').value = ''; $('pw2').value = '';
    passo('f-password');
  } catch (e) { passo('f-codice', messaggio(e)); }
};
$('f-password').onsubmit = async (ev) => {
  ev.preventDefault();
  const a = $('pw1').value;
  if (a.length < 8) { passo('f-password', 'La password deve avere almeno 8 caratteri.'); return; }
  if (a !== $('pw2').value) { passo('f-password', 'Le due password non coincidono.'); return; }
  try {
    stato.utente = await stato.be.impostaPassword(a);
    $('pw1').value = ''; $('pw2').value = '';
    await entra();
  } catch (e) { passo('f-password', messaggio(e)); }
};

async function mostra() {
  $('login').hidden = true; $('app').hidden = false;
  document.body.classList.toggle('coord', isCoord());
  for (const b of document.querySelectorAll('.solo-coord')) b.hidden = !isCoord();
  $('utente').textContent = stato.utente.name;
  $('btn-esci').hidden = stato.be.demo;
  $('btn-password').hidden = stato.be.demo;
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

// la linea della notte si traccia misurando le caselle: va rifatta se cambia la larghezza della pagina
function ridisegnaNotti() { try { tracciaNotti($('foglio')); } catch { /* ignora */ } }
let attesaNotti = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(attesaNotti); attesaNotti = requestAnimationFrame(ridisegnaNotti); });
if (document.fonts?.ready) document.fonts.ready.then(ridisegnaNotti);

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

  document.body.classList.toggle('operatore', !isCoord());
  $('f-servizio').textContent = CONFIG.SERVIZIO;
  $('f-mese').textContent = `${nomeMese(stato.m).toUpperCase()} ${stato.y}`;

  // gli operatori non vedono i mesi non pubblicati
  const nascosto = !isCoord() && !pubblicato;
  mostraMessaggio(nascosto
    ? 'Il piano di questo mese non è ancora stato pubblicato.'
    : (isCoord() && !pubblicato ? 'Bozza: gli operatori non la vedono finché non la pubblichi.' : ''));
  $('pagina').hidden = nascosto;
  $('btn-pdf').hidden = nascosto;
  disegnaConsensi();
  if (nascosto) return;

  $('legenda').innerHTML = righeLegenda(events, stato.y, stato.m, shifts).map((r) => `<li class="${r.cls}">${r.html}</li>`).join('');
  $('foglio').innerHTML = renderGrid({
    year: stato.y, month: stato.m, staff, shifts, events,
    editable: isCoord() && stato.modifica,
    evidenzia: isCoord() ? null : stato.utente.staffId,          // gli operatori vedono la propria riga riquadrata in blu
  });
  $('foglio').classList.toggle('modificabile', isCoord() && stato.modifica);
  ridisegnaNotti();

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
// Logo per il PDF: si legge assets/logo.png (se c'è) e si converte in pixel RGB su fondo bianco
let logoPdf = null;
async function leggiLogo() {
  try {
    const r = await fetch('assets/logo.png');
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const rgb = new Uint8Array(c.width * c.height * 3);
    for (let i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
    return { w: c.width, h: c.height, rgb };
  } catch { return null; }
}

// PDF del foglio (A4 orizzontale): si salva sul dispositivo e poi si stampa da lì.
// Su telefono si apre il menu di condivisione (Salva su File, Stampa, WhatsApp...), sul computer si scarica.
$('btn-pdf').onclick = async () => {
  try {
    const { month, staff, shifts, events } = stato.dati;
    if (!logoPdf) logoPdf = leggiLogo();
    const logo = await logoPdf;
    const bytes = creaPdf({ year: stato.y, month: stato.m, staff, shifts, events, servizio: CONFIG.SERVIZIO, note: month.notes || '', logo, evidenzia: isCoord() ? null : stato.utente.staffId });
    const nome = nomeFilePdf(stato.y, stato.m);
    const file = new File([bytes], nome, { type: 'application/pdf' });
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: nome }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Non sono riuscito a creare il PDF: ' + e.message); }
};
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
  const cop = esistenti.find((e) => e.kind === 'COP');
  $('cop-da').value = cop?.start_time ? cop.start_time.slice(0, 5) : '';
  $('cop-a').value = cop?.end_time ? cop.end_time.slice(0, 5) : '';
  const aggiorna = () => {
    for (const b of box.children) b.classList.toggle('on', cellaCorrente.scelti.has(b.dataset.kind));
    $('cella-cop').hidden = !cellaCorrente.scelti.has('COP');
  };
  const aiutoBase = $('cella-aiuto').textContent;
  box.onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b || b.disabled) return;
    const k = b.dataset.kind, sc = cellaCorrente.scelti;
    $('cella-aiuto').textContent = aiutoBase;
    if (k === 'MU' && !sc.has('MU') && SENZA_MALATTIA.some((x) => sc.has(x))) {
      $('cella-aiuto').textContent = 'La malattia non si mette insieme a ferie, riposi e permessi.'; return;
    }
    if (k === 'MU' && !sc.has('MU') && !PER_MALATTIA.some((x) => sc.has(x))) {
      $('cella-aiuto').textContent = 'Per la malattia scegli prima che cosa avrebbe dovuto fare (turno, 10–18, copertura, spesa), poi tocca MU. Non si può con ferie, riposi e permessi.'; return;
    }
    if (sc.has(k)) sc.delete(k);
    else {
      if (ESCLUSIVI.includes(k)) {
        // un giorno ha un solo turno principale: scegliere M, P, N, riposo, ferie... toglie quello scelto prima
        const fissi = ESCLUSIVI.filter((x) => sc.has(x) && cellaCorrente.bloccata && cellaCorrente.protetti.has(x));
        if (fissi.length) { $('cella-aiuto').textContent = 'Questa casella è protetta: non si può cambiare il suo turno senza il consenso.'; return; }
        for (const x of ESCLUSIVI) sc.delete(x);
        if (SENZA_MALATTIA.includes(k)) sc.delete('MU');             // ferie, riposi e permessi non vanno con la malattia
      }
      sc.add(k);
    }
    if (!PER_MALATTIA.some((x) => sc.has(x))) sc.delete('MU');
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
  if (c.scelti.has('COP') && (!$('cop-da').value || !$('cop-a').value || $('cop-da').value === $('cop-a').value)) {
    alert('Per la copertura indica l\'ora di inizio e quella di fine.'); return;
  }
  const voci = [...c.scelti].map((kind) => {
    if (c.bloccata && c.protetti.has(kind)) {                      // voce protetta: resta identica
      return { kind, requested: !!c.esistenti.find((e) => e.kind === kind)?.requested };
    }
    const v = { kind, requested: rich && 'MPN'.includes(kind) };
    const ex = c.esistenti.find((e) => e.kind === kind);
    if (ex && ['M', 'P', 'N'].includes(kind)) { v.start_time = ex.start_time || null; v.end_time = ex.end_time || null; }   // gli orari modificati restano
    if (kind === 'T1018') { v.start_time = '10:00'; v.end_time = '18:00'; }
    if (kind === 'COP') { v.start_time = $('cop-da').value; v.end_time = $('cop-a').value; }
    return v;
  });
  if (ESCLUSIVI.filter((k) => c.scelti.has(k)).length > 1) {
    alert('In un giorno si può avere un solo turno principale (M, P, N, riposo, ferie, permesso, 10–18). Tieni solo uno.'); return;
  }
  const turniScelti = ['M', 'P', 'N'].filter((k) => c.scelti.has(k));
  if (c.scelti.has('MU') && !PER_MALATTIA.some((k) => c.scelti.has(k))) {
    alert('Per la malattia lascia selezionato quello che avrebbe dovuto fare (turno, 10–18, copertura o spesa).'); return;
  }
  if (c.scelti.has('MU') && SENZA_MALATTIA.some((k) => c.scelti.has(k))) {
    alert('La malattia non si mette insieme a ferie, riposi o permessi.'); return;
  }
  const nuovaMalattia = c.scelti.has('MU') && !c.esistenti.some((e) => e.kind === 'MU');
  const ok = await salvaCella(voci);
  if (ok && nuovaMalattia && turniScelti.length === 1) apriCopertura(c.staffId, c.data, turniScelti[0]);   // la copertura dei colleghi si propone per i turni M, P, N
});
async function salvaCella(voci) {
  const c = cellaCorrente;
  try {
    await stato.be.impostaCella(c.staffId, c.data, voci);
    if (c.sblocco) await stato.be.chiudiSblocco(c.staffId, c.data, 'used');
    $('dlg-cella').close();
    await carica();
    return true;
  } catch (e) { alert('Non sono riuscito a salvare: ' + e.message); return false; }
}

// ------------------------------------------------------------ copertura di una malattia
let copertura = null;
function apriCopertura(staffId, data, turno) {
  const malato = nomePersona(staffId);
  const prop = proponiCopertura({ shifts: stato.dati.shifts, staff: stato.dati.staff, staffId, date: data, turno });
  const voci = [];
  if (prop.prima) voci.push({ ...prop.prima, ruolo: 'turno prima', verbo: `resta fino alle ${prop.prima.fine}` });
  if (prop.dopo) voci.push({ ...prop.dopo, ruolo: 'turno dopo', verbo: `entra alle ${prop.dopo.inizio}` });
  copertura = voci;
  $('cop-testo').textContent = `${malato} in malattia, ${dataEstesa(data)} (turno ${turno}). Per coprire le 8 ore, ${prop.ore} ore a testa a chi sta prima e a chi sta dopo.`;
  $('cop-righe').innerHTML = voci.length
    ? voci.map((v, i) => `<label><input type="checkbox" data-i="${i}" checked><span><b>${v.nome}</b> (${v.ruolo}, ${dataEstesa(v.date)}): ${v.verbo} · ${v.inizio}–${v.fine} · <b>${etichettaScostamento(prop.ore)}</b> ore</span></label>`).join('')
    : '<p>Non trovo nessuno nel turno prima o dopo: la copertura va organizzata a mano.</p>';
  $('cop-si').hidden = !voci.length;
  $('cop-no').textContent = voci.length ? 'Non ora' : 'Chiudi';
  $('dlg-copertura').showModal();
}
$('cop-no').onclick = () => $('dlg-copertura').close();
$('cop-si').onclick = async () => {
  const scelte = [...$('cop-righe').querySelectorAll('input:checked')].map((i) => copertura[+i.dataset.i]);
  try {
    for (const v of scelte) await stato.be.impostaOrario(v.staffId, v.date, v.kind, v.inizio, v.fine);
  } catch (e) { alert('Non sono riuscito ad applicare: ' + e.message); return; }
  $('dlg-copertura').close();
  await carica();
};

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

// ------------------------------------------------------------ cambio password
function cambioErrore(t) { $('cambio-err').textContent = t || ''; $('cambio-err').hidden = !t; }
$('btn-password').onclick = () => {
  cambioErrore('');
  $('cambio-testo').textContent = 'Per sicurezza ti mando un codice alla tua email.';
  $('cambio-invia').hidden = false; $('cambio-campi').hidden = true; $('cambio-salva').hidden = true;
  for (const i of ['cambio-codice', 'cambio-pw1', 'cambio-pw2']) $(i).value = '';
  $('dlg-password').showModal();
};
$('cambio-chiudi').onclick = () => $('dlg-password').close();
$('cambio-invia').onclick = async () => {
  cambioErrore('');
  try {
    await stato.be.codicePerCambio();
    $('cambio-testo').textContent = 'Ti ho inviato un codice via email. Scrivilo qui sotto con la nuova password.';
    $('cambio-invia').hidden = true; $('cambio-campi').hidden = false; $('cambio-salva').hidden = false;
  } catch (e) { cambioErrore(messaggio(e)); }
};
$('cambio-salva').onclick = async () => {
  const a = $('cambio-pw1').value;
  if (!$('cambio-codice').value.trim()) return cambioErrore('Scrivi il codice ricevuto per email.');
  if (a.length < 8) return cambioErrore('La password deve avere almeno 8 caratteri.');
  if (a !== $('cambio-pw2').value) return cambioErrore('Le due password non coincidono.');
  try {
    await stato.be.cambiaPassword(a, $('cambio-codice').value.trim());
    $('dlg-password').close();
    mostraMessaggio('Password cambiata.'); setTimeout(() => { if ($('messaggio').textContent === 'Password cambiata.') disegna(); }, 3000);
  } catch (e) { cambioErrore(messaggio(e)); }
};

// ------------------------------------------------------------ gestione personale
let personale = [];
const oggiIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dataIt = (d) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function elencaPersonale() {
  try { personale = await stato.be.elencoPersonale(); } catch (e) { $('personale-lista').innerHTML = `<li class="err">${esc(messaggio(e))}</li>`; return; }
  const oggi = oggiIso();
  $('personale-lista').innerHTML = personale.map((p, i) => {
    const finito = p.end_date && p.end_date < oggi;
    const tag = p.role === 'coordinator' ? '<span class="tag">Coordinatrice</span>' : (p.ha_accesso ? '<span class="tag">Ha già l\'accesso</span>' : '<span class="tag attesa">Non ha ancora fatto il primo accesso</span>');
    const date = [p.start_date ? 'dal ' + dataIt(p.start_date) : '', p.end_date ? (finito ? 'fino al ' : 'fino al ') + dataIt(p.end_date) : ''].filter(Boolean).join(' ');
    return `<li class="${finito ? 'finito' : ''}"><span class="chi"><b>${esc(p.name)}</b><small>${esc(p.email || 'senza email')}${date ? ' · ' + date : ''}</small></span>${tag}
      <button type="button" data-su="${i}" aria-label="Sposta su" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-giu="${i}" aria-label="Sposta giù" ${i === personale.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" data-mod="${i}">Modifica</button></li>`;
  }).join('');
}
$('btn-personale').onclick = async () => { await elencaPersonale(); $('dlg-personale').showModal(); };
$('personale-chiudi').onclick = async () => { $('dlg-personale').close(); await carica(); };
$('personale-lista').onclick = async (ev) => {
  const d = ev.target.dataset; if (!d) return;
  if (d.mod !== undefined) return apriPersona(personale[+d.mod]);
  const da = d.su !== undefined ? +d.su : d.giu !== undefined ? +d.giu : null;
  if (da === null) return;
  const a = d.su !== undefined ? da - 1 : da + 1;
  // riscrive l'ordine con numeri distinti, scambiando le due posizioni
  const ordine = personale.map((p) => p.id); [ordine[da], ordine[a]] = [ordine[a], ordine[da]];
  try {
    for (let k = 0; k < ordine.length; k++) { const p = personale.find((x) => x.id === ordine[k]); if (p.sort_order !== (k + 1) * 10) await stato.be.ordinaPersona(p.id, (k + 1) * 10); }
  } catch (e) { alert(messaggio(e)); }
  await elencaPersonale();
};
let personaCorrente = null;
function personaErrore(t) { $('persona-err').textContent = t || ''; $('persona-err').hidden = !t; }
function apriPersona(p) {
  personaCorrente = p || null; personaErrore('');
  $('persona-titolo').textContent = p ? `Modifica ${p.name}` : 'Nuovo operatore';
  $('pe-nome').value = p?.name || ''; $('pe-email').value = p?.email || '';
  const bloccata = !!p?.ha_accesso;
  $('pe-email').disabled = bloccata; $('pe-email-nota').hidden = !bloccata;
  $('pe-inizio').value = p?.start_date || (p ? '' : oggiIso()); $('pe-fine').value = p?.end_date || '';
  $('pe-ore').value = p?.contract_hours ?? ''; $('pe-fisso').checked = !!p?.fixed_pattern;
  const coord = p?.role === 'coordinator';
  $('pe-fine').disabled = coord || p?.user_id === stato.utente.staffId || p?.id === stato.utente.staffId;
  $('pe-elimina').hidden = !p || coord;
  $('dlg-persona').showModal();
}
$('personale-nuovo').onclick = () => apriPersona(null);
$('pe-annulla').onclick = () => $('dlg-persona').close();
$('pe-salva').onclick = async () => {
  const nome = $('pe-nome').value.trim(), email = $('pe-email').value.trim().toLowerCase();
  if (!nome) return personaErrore('Scrivi il nome.');
  if (!personaCorrente?.ha_accesso && !email) return personaErrore('Scrivi l\'email di lavoro: serve per il primo accesso.');
  const ini = $('pe-inizio').value, fin = $('pe-fine').value;
  if (ini && fin && fin < ini) return personaErrore('L\'ultimo giorno non può essere prima del primo.');
  const ore = $('pe-ore').value;
  try {
    await stato.be.salvaPersona({
      id: personaCorrente?.id, name: nome, email, emailModificabile: !personaCorrente?.ha_accesso,
      start_date: ini, end_date: fin, contract_hours: ore === '' ? null : +ore, fixed_pattern: $('pe-fisso').checked,
      sort_order: (Math.max(0, ...personale.map((p) => p.sort_order || 0)) || 0) + 10,
    });
    $('dlg-persona').close(); await elencaPersonale();
  } catch (e) { personaErrore(/duplicate|unique/i.test(messaggio(e)) ? 'Questa email è già usata da un\'altra persona.' : messaggio(e)); }
};
$('pe-elimina').onclick = async () => {
  if (!personaCorrente) return;
  if (!confirm(`Eliminare ${personaCorrente.name}? Si può fare solo se non ha mai avuto turni né accesso; altrimenti imposta la data di fine servizio.`)) return;
  try { await stato.be.eliminaPersona(personaCorrente.id); $('dlg-persona').close(); await elencaPersonale(); }
  catch (e) { personaErrore(messaggio(e)); }
};

avvia().catch((e) => mostraMessaggio('Errore: ' + e.message));
