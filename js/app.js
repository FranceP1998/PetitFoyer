import { creaBackend } from './data.js';
import { CONFIG } from './config.js';
import { renderGrid, righeLegenda, nomeMese, pad, eProtetta, tracciaNotti } from './grid.js';
import { creaPdf, nomeFilePdf } from './pdf.js';
import { proponiCopertura } from './mutua.js';
import { etichettaScostamento, STANDARD, inServizio } from './cella.js';

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

const stato = { be: null, utente: null, y: 0, m: 0, dati: null, modifica: false, sblocchi: [], notifiche: [], malattie: [], richieste: [], mesiAperti: [] };
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
  for (const b of document.querySelectorAll('.solo-op')) b.hidden = isCoord();
  $('utente').textContent = `${stato.utente.name} · v15`;
  $('btn-esci').hidden = stato.be.demo;
  $('btn-password').hidden = stato.be.demo;
  await carica();
}

async function carica() {
  $('titolo-mese').textContent = `${nomeMese(stato.m)} ${stato.y}`;
  try { history.replaceState(null, '', `#${stato.y}-${stato.m}`); } catch { /* ignora */ }
  try { await stato.be.elaboraScadenze(); } catch { /* ignora */ }   // richieste non esaminate dopo il 20: valgono come accettate
  try {
    stato.dati = await stato.be.caricaMese(stato.y, stato.m);
  } catch (e) { mostraMessaggio('Non riesco a caricare i dati: ' + e.message); return; }
  try { stato.sblocchi = await stato.be.elencaSblocchi(); } catch { stato.sblocchi = []; }
  try { stato.notifiche = await stato.be.elencaNotifiche(); } catch { stato.notifiche = []; }
  try { stato.malattie = isCoord() ? await stato.be.elencaMalattie() : []; } catch { stato.malattie = []; }
  try { stato.richieste = await stato.be.elencaRichieste(stato.y, stato.m); } catch { stato.richieste = []; }
  stato.mesiErr = '';
  try { stato.mesiAperti = isCoord() ? [] : await stato.be.mesiRichieste(); } catch (e) { stato.mesiAperti = []; stato.mesiErr = messaggio(e); }
  disegna();
}

// la linea della notte si traccia misurando le caselle: va rifatta se cambia la larghezza della pagina
function ridisegnaNotti() { try { tracciaNotti($('foglio')); } catch { /* ignora */ } }
let attesaNotti = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(attesaNotti); attesaNotti = requestAnimationFrame(ridisegnaNotti); });
if (document.fonts?.ready) document.fonts.ready.then(ridisegnaNotti);

function mostraMessaggio(t) { const p = $('messaggio'); p.textContent = t || ''; p.hidden = !t; }

// le richieste ancora senza risposta compaiono sul foglio (tratteggiate; gialle se critiche)
function richiestePerFoglio() {
  return stato.richieste.filter((r) => r.status === 'pending').map((r) => ({
    staff_id: r.staff_id, date: r.date, kind: r.kind, requested: r.kind !== 'RR', pending: true, critica: (r.avvisi || []).length > 0,
  }));
}

const meseAperto = (y, m) => stato.mesiAperti.find((x) => x.year === y && x.month === m) || null;

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

  // finché il mese non è pubblicato gli operatori vedono solo ferie, permessi e richieste (di tutti)
  mostraMessaggio(!isCoord() && !pubblicato
    ? 'Piano in preparazione: per ora vedi solo ferie, permessi e richieste di tutti. I turni compaiono quando Marie pubblica.'
    : (isCoord() && !pubblicato ? 'Bozza: gli operatori ne vedono solo ferie, permessi e richieste, finché non la pubblichi.' : ''));
  $('pagina').hidden = false;
  const aperto = meseAperto(stato.y, stato.m);
  if (!isCoord() && stato.mesiErr) {
    mostraMessaggio('Non riesco a leggere quali richieste sono aperte: ' + stato.mesiErr);
  } else if (!isCoord() && !aperto && stato.mesiAperti.length) {
    const el = stato.mesiAperti.map((x) => `${nomeMese(x.month).toLowerCase()} ${x.year} (entro il ${x.scadenza.slice(8, 10)}/${x.scadenza.slice(5, 7)})`).join(', ');
    mostraMessaggio(`Le richieste di ${nomeMese(stato.m).toLowerCase()} non sono aperte. Sono aperte quelle di: ${el}. Vai a quel mese e clicca su un giorno della tua riga.`);
  } else if (!isCoord() && aperto) {
    mostraMessaggio(`Richieste aperte fino al ${aperto.scadenza.slice(8, 10)}/${aperto.scadenza.slice(5, 7)}: clicca su un giorno della tua riga per chiedere un riposo o un turno. ` + (pubblicato ? '' : 'Piano in preparazione: per ora vedi solo ferie, permessi e richieste di tutti.'));
  }
  $('foglio').classList.toggle('richiedibile', !isCoord() && !!aperto);
  $('btn-pdf').hidden = !isCoord() && !pubblicato;
  const inAttesa = isCoord() ? stato.richieste.filter((r) => r.status === 'pending').length : 0;
  $('btn-richieste').textContent = inAttesa ? `Richieste (${inAttesa})` : 'Richieste';
  disegnaConsensi();
  disegnaNotifiche();
  disegnaMalattie();

  $('legenda').innerHTML = righeLegenda(events, stato.y, stato.m, shifts).map((r) => `<li class="${r.cls}">${r.html}</li>`).join('');
  $('foglio').innerHTML = renderGrid({
    year: stato.y, month: stato.m, staff, shifts: [...shifts, ...richiestePerFoglio()], events,
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

// ------------------------------------------------------------ notifiche nell'app
function disegnaNotifiche() {
  const box = $('notifiche');
  box.innerHTML = stato.notifiche.map((n) => `<div class="consenso notifica" role="status"><p>${esc(n.text)}</p>
    <div class="consenso-azioni"><button data-letta="${n.id}">Ok, letto</button></div></div>`).join('');
  box.hidden = !stato.notifiche.length;
}
$('notifiche').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-letta]'); if (!b) return;
  try { await stato.be.segnaNotificaLetta(+b.dataset.letta); } catch (e) { alert(messaggio(e)); }
  await carica();
});

// ------------------------------------------------------------ richieste di riposo o di turno
const TIPO_RICHIESTA = { RR: 'Riposo', M: 'Mattina', P: 'Pomeriggio', N: 'Notte' };
const STATO_RICHIESTA = { pending: 'In attesa', accepted: 'Accettata', rejected: 'Rifiutata' };
const MAX_RICHIESTE = 3;
let ricMeseOp = null;                                  // mese scelto dall'operatore: { year, month, scadenza }
function ricErrore(t) { $('ric-err').textContent = t || ''; $('ric-err').hidden = !t; }
const ricMese = () => (isCoord() ? { year: stato.y, month: stato.m } : (ricMeseOp || { year: stato.y, month: stato.m }));

async function apriRichieste(dataScelta = null) {
  ricErrore('');
  $('ric-coord').hidden = !isCoord(); $('ric-op').hidden = isCoord();
  if (isCoord()) {
    $('ric-titolo').textContent = `Richieste di ${nomeMese(stato.m).toLowerCase()} ${stato.y}`;
    $('ric-testo').textContent = 'Accetta o rifiuta man mano che arrivano. Le richieste in giallo non rispettano le regole: per accettarle o rifiutarle scrivi la motivazione. Dopo il 20 del mese prima quelle non esaminate valgono come accettate.';
  } else {
    $('ric-titolo').textContent = 'Richieste di riposo o di turno';
    let mesi = [];
    try { mesi = await stato.be.mesiRichieste(); } catch (e) { ricErrore(messaggio(e)); }
    $('ric-mese').innerHTML = mesi.map((x, i) => `<option value="${i}">${nomeMese(x.month)} ${x.year}</option>`).join('');
    $('ric-mese').onchange = () => { ricMeseOp = mesi[+$('ric-mese').value]; disegnaRichieste(); };
    ricMeseOp = (dataScelta && mesi.find((x) => x.year === +dataScelta.slice(0, 4) && x.month === +dataScelta.slice(5, 7))) || mesi[0] || null;
    if (ricMeseOp) $('ric-mese').value = String(mesi.indexOf(ricMeseOp));
    if (dataScelta && ricMeseOp && ricMeseOp.year === +dataScelta.slice(0, 4) && ricMeseOp.month === +dataScelta.slice(5, 7)) $('ric-data').value = dataScelta;
    $('ric-op').hidden = !mesi.length;
    $('ric-testo').textContent = mesi.length
      ? `Puoi chiedere al massimo ${MAX_RICHIESTE} tra riposi e turni al mese. Ferie e permessi sono un'altra cosa. Se più persone chiedono lo stesso turno vale chi lo chiede per primo. Se una regola non è rispettata (per esempio una mattina dopo un pomeriggio) puoi comunque chiedere: Marie la vedrà in giallo e deciderà. Le richieste non esaminate entro il 20 valgono come accettate. Qui vedi anche quelle dei colleghi.`
      : 'Al momento le richieste non sono aperte: Marie le apre prima di ogni mese e ti avvisa.';
  }
  await disegnaRichieste();
  if (!$('dlg-richieste').open) $('dlg-richieste').showModal();
}

async function disegnaRichieste() {
  const mese = ricMese();
  const lista = $('ric-lista');
  if (!mese) { lista.innerHTML = ''; $('ric-apri').hidden = true; return; }
  let righe = [];
  try { righe = await stato.be.elencaRichieste(mese.year, mese.month); } catch (e) { ricErrore(messaggio(e)); }
  if (mese.year === stato.y && mese.month === stato.m) stato.richieste = righe;
  if (isCoord()) {
    const aperto = !!stato.dati?.month?.requests_open;
    $('ric-stato').innerHTML = aperto
      ? `Le richieste sono <b>aperte</b>: gli operatori possono inserirle entro il 20 del mese prima.`
      : `Le richieste sono <b>chiuse</b>: gli operatori non possono inserirne.`;
    $('ric-apri').hidden = false;
    $('ric-apri').textContent = aperto ? 'Chiudi le richieste' : 'Apri le richieste e avvisa gli operatori';
    $('ric-apri').className = aperto ? '' : 'primario';
  } else {
    const d0 = `${mese.year}-${pad(mese.month)}-01`, d1 = `${mese.year}-${pad(mese.month)}-${pad(new Date(mese.year, mese.month, 0).getDate())}`;
    $('ric-data').min = d0; $('ric-data').max = d1;
    if (!$('ric-data').value || $('ric-data').value < d0 || $('ric-data').value > d1) $('ric-data').value = d0;
  }
  const mie = righe.filter((r) => r.staff_id === stato.utente.staffId && ['pending', 'accepted'].includes(r.status)).length;
  const ordine = { pending: 0, accepted: 1, rejected: 2 };
  righe = [...righe].sort((a, b) => ordine[a.status] - ordine[b.status] || a.date.localeCompare(b.date));
  const intest = isCoord() ? '' : `<li class="muted"><span>Hai usato ${mie} richieste su ${MAX_RICHIESTE}. Qui sotto vedi quelle di tutti.</span></li>`;
  lista.innerHTML = intest + (righe.length ? righe.map((r) => {
    const mia = r.staff_id === stato.utente.staffId;
    const avvisi = r.avvisi || [];
    const chi = `<b>${esc(nomePersona(r.staff_id))}</b> · `;
    const critica = r.status === 'pending' && avvisi.length;
    let azioni = '';
    if (r.status === 'pending') {
      azioni = isCoord()
        ? `<span class="azioni"><button type="button" class="primario" data-ric-ok="${r.id}">Accetta</button><button type="button" data-ric-no="${r.id}">Rifiuta</button></span>`
        : (mia ? `<span class="azioni"><button type="button" class="link" data-ric-annulla="${r.id}">Annulla</button></span>` : '');
    }
    const motivoIn = r.status === 'pending' && isCoord()
      ? `<input type="text" class="ric-motivo" placeholder="${avvisi.length ? 'Motivazione (obbligatoria: richiesta critica)' : 'Motivazione (obbligatoria se rifiuti)'}" data-motivo-di="${r.id}">` : '';
    const nota = (avvisi.length && r.status !== 'rejected' ? `<span class="avvisi">⚠ ${avvisi.map(esc).join(' ')}</span>` : '')
      + (r.motivo ? `<span class="motivo">Marie: ${esc(r.motivo)}</span>` : '');
    return `<li class="${critica ? 'critica ' : ''}col"><span class="chi">${chi}${dataEstesa(r.date)} · ${TIPO_RICHIESTA[r.kind]}${nota}</span><span class="stato ${r.status === 'accepted' ? 'accettata' : r.status === 'rejected' ? 'rifiutata' : ''}">${STATO_RICHIESTA[r.status]}</span>${azioni}${motivoIn}</li>`;
  }).join('') : '<li class="muted"><span>Nessuna richiesta per questo mese.</span></li>');
  $('btn-richieste').textContent = isCoord() && stato.richieste.some((r) => r.status === 'pending') ? `Richieste (${stato.richieste.filter((r) => r.status === 'pending').length})` : 'Richieste';
}

$('btn-richieste').onclick = () => apriRichieste();
$('ric-chiudi').onclick = async () => { $('dlg-richieste').close(); await carica(); };
$('ric-invia').onclick = async () => {
  ricErrore('');
  const data = $('ric-data').value;
  if (!data) return ricErrore('Scegli il giorno.');
  const tipo = $('ric-tipo').value;
  try {
    try { await stato.be.inviaRichiesta(data, tipo, false); }
    catch (e) {
      const m = messaggio(e);
      if (!m.startsWith('[avviso]')) throw e;
      // qualche regola non è rispettata: l'operatore può comunque chiedere, ma Marie la vedrà in giallo
      if (!confirm(`${m.replace('[avviso] ', '')}\n\nPuoi inviare comunque la richiesta: Marie la vedrà segnata come critica e deciderà lei.\n\nInviarla comunque?`)) return;
      await stato.be.inviaRichiesta(data, tipo, true);
    }
  } catch (e) { return ricErrore(messaggio(e)); }
  await carica(); await disegnaRichieste();
};
$('ric-apri').onclick = async () => {
  ricErrore('');
  try {
    await stato.be.impostaRichieste(stato.y, stato.m, !stato.dati.month.requests_open);
    stato.dati = await stato.be.caricaMese(stato.y, stato.m);
  } catch (e) { return ricErrore(messaggio(e)); }
  await disegnaRichieste();
};
$('ric-lista').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  ricErrore('');
  try {
    if (b.dataset.ricAnnulla) { await stato.be.annullaRichiesta(+b.dataset.ricAnnulla); stato.richieste = await stato.be.elencaRichieste(stato.y, stato.m); disegna(); }
    else if (b.dataset.ricOk || b.dataset.ricNo) {
      const id = +(b.dataset.ricOk || b.dataset.ricNo), accetta = !!b.dataset.ricOk;
      const motivo = b.closest('li').querySelector('.ric-motivo')?.value || '';
      await stato.be.rispondiRichiesta(id, accetta, motivo);
      stato.dati = await stato.be.caricaMese(stato.y, stato.m);
      stato.richieste = await stato.be.elencaRichieste(stato.y, stato.m); disegna();
    }
  } catch (e) { return ricErrore(messaggio(e)); }
  await disegnaRichieste();
});

// ------------------------------------------------------------ malattia: pannello della coordinatrice
const TURNO_SALTATO = { M: 'mattina', P: 'pomeriggio', N: 'notte', T1018: 'turno 10–18', COP: 'copertura', SPESA: 'copertura spesa', RB: 'recupero ore' };
function disegnaMalattie() {
  const box = $('malattie');
  box.innerHTML = stato.malattie.map((r) => `<div class="consenso malattia">
    <p><b>${esc(nomePersona(r.staff_id))}</b> è in malattia dal ${dataIt(r.first_day)} al ${dataIt(r.last_day)}. Turni da coprire:</p>
    <ul class="mal-giorni">${r.days.map((d, i) => {
      const nome = `${dataEstesa(d.date)} · ${TURNO_SALTATO[d.kind] || d.kind}`;
      if (d.done) return `<li class="fatto"><span>✓ ${nome}</span><button type="button" class="link" data-mal="${r.id}" data-i="${i}">Cambia</button></li>`;
      return `<li><span>${nome}</span><span class="mal-azioni">
        <button type="button" data-mal="${r.id}" data-i="${i}">Scegli la copertura</button>
        <button type="button" class="link" data-sistemata="${r.id}" data-i="${i}">Già sistemata</button></span></li>`;
    }).join('')}</ul>
  </div>`).join('');
  box.hidden = !stato.malattie.length;
}
$('malattie').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    const id = b.dataset.mal || b.dataset.sistemata;
    if (!id) return;
    const r = stato.malattie.find((x) => x.id === +id), d = r.days[+b.dataset.i];
    if (b.dataset.sistemata) {                      // sistemata a mano o senza copertura: il giorno risulta fatto senza altre modifiche
      await stato.be.applicaCopertura(r.id, d.date, []); await carica(); return;
    }
    const [yy, mm] = d.date.split('-').map(Number);
    if (yy !== stato.y || mm !== stato.m) { stato.y = yy; stato.m = mm; await carica(); }       // la copertura si propone guardando quel mese
    apriCopertura(r.staff_id, d.date, d.kind, { report: r.id, giorno: d.date });
  } catch (e) { alert(messaggio(e)); }
});

// ------------------------------------------------------------ malattia: comunicazione dell'operatore
function malErrore(t) { $('ml-err').textContent = t || ''; $('ml-err').hidden = !t; }
function malReset() { $('ml-anteprima').innerHTML = ''; malErrore(''); $('ml-conferma').hidden = true; $('ml-controlla').hidden = false; }
$('btn-malattia').onclick = () => { $('ml-da').value = oggiIso(); $('ml-a').value = ''; malReset(); $('dlg-malattia').showModal(); };
$('ml-da').onchange = malReset; $('ml-a').onchange = malReset;
$('ml-chiudi').onclick = async () => { $('dlg-malattia').close(); await carica(); };
$('ml-controlla').onclick = async () => {
  malReset();
  const da = $('ml-da').value, a = $('ml-a').value;
  if (!da || !a) return malErrore('Scrivi il primo e l\'ultimo giorno.');
  if (a < da) return malErrore('L\'ultimo giorno non può essere prima del primo.');
  try {
    const r = await stato.be.anteprimaMalattia(da, a);
    const elenco = r.giorni.map((g) => `<li>${dataEstesa(g.date)} · ${TURNO_SALTATO[g.kind] || g.kind}</li>`).join('');
    let html = '';
    if (r.giorni.length) html += `<p>Questi turni diventano malattia:</p><ul>${elenco}</ul>`;
    if (r.giorni_bozza) html += `<p>${r.giorni_bozza === 1 ? 'Un altro giorno cade' : r.giorni_bozza + ' altri giorni cadono'} in un piano non ancora pubblicato: la malattia viene segnata comunque.</p>`;
    if (!r.giorni.length && !r.giorni_bozza) html = '<p>In quei giorni non hai turni da modificare (riposi, ferie e permessi restano com\'erano). Non c\'è niente da comunicare.</p>';
    else html += '<p>Marie riceve l\'avviso e sceglie le coperture. I colleghi vengono avvisati solo dopo la sua scelta.</p>';
    $('ml-anteprima').innerHTML = html;
    $('ml-conferma').hidden = !(r.giorni.length || r.giorni_bozza);
  } catch (e) { malErrore(messaggio(e)); }
};
$('ml-conferma').onclick = async () => {
  try {
    const r = await stato.be.comunicaMalattia($('ml-da').value, $('ml-a').value);
    const n = r.giorni.length;
    $('ml-anteprima').innerHTML = `<p><b>Fatto.</b> Ho segnato la malattia su ${n} ${n === 1 ? 'turno' : 'turni'} e ho avvisato Marie.</p>`;
    $('ml-conferma').hidden = true; $('ml-controlla').hidden = true;
    await carica();
  } catch (e) { malErrore(messaggio(e)); }
};

// ------------------------------------------------------------ modifica cella
let cellaCorrente = null;
$('foglio').addEventListener('click', (ev) => {
  // operatore: un clic su un giorno della propria riga apre la richiesta per quel giorno (se le richieste sono aperte)
  if (!isCoord()) {
    const c = ev.target.closest('td[data-p]');
    if (!c || +c.dataset.p !== stato.utente.staffId) return;
    if (!meseAperto(+c.dataset.d.slice(0, 4), +c.dataset.d.slice(5, 7))) {
      alert(stato.mesiErr ? 'Non riesco a leggere quali richieste sono aperte: ' + stato.mesiErr
        : `Le richieste di ${nomeMese(stato.m).toLowerCase()} ${stato.y} non sono aperte (Marie le apre prima di ogni mese e ti avvisa; si chiudono il 20 del mese prima).`);
      return;
    }
    apriRichieste(c.dataset.d);
    return;
  }
  if (!stato.modifica) return;
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
  if (!$('dlg-cella').open) { $('dlg-cella').showModal(); document.activeElement?.blur(); }   // niente alone sul primo simbolo (sembrava selezionato)
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
// La coordinatrice può accettare la proposta (+4 ore a chi sta prima e a chi sta dopo) oppure
// aggiungere un'altra persona con gli orari concordati (copertura COP). Quando applica, il giorno risulta fatto.
let copertura = null;
function apriCopertura(staffId, data, turno, ctx = null) {
  const malato = nomePersona(staffId);
  const prop = proponiCopertura({ shifts: stato.dati.shifts, staff: stato.dati.staff, staffId, date: data, turno });
  const voci = [];
  if (prop.prima) voci.push({ ...prop.prima, ruolo: 'turno prima', verbo: `resta fino alle ${prop.prima.fine}`, scost: prop.ore, kindScost: 'fine' });
  if (prop.dopo) voci.push({ ...prop.dopo, ruolo: 'turno dopo', verbo: `entra alle ${prop.dopo.inizio}`, scost: prop.ore, kindScost: 'inizio' });
  const sk = stato.dati.shifts.find((x) => x.staff_id === staffId && x.date === data && x.kind === turno);
  const [s0, e0] = STANDARD[turno] || ['', ''];
  copertura = { voci, ctx, staffId, data, turno, inizio: String(sk?.start_time || s0).slice(0, 5), fine: String(sk?.end_time || e0).slice(0, 5) };
  $('cop-testo').textContent = `${malato} in malattia, ${dataEstesa(data)} (turno ${turno}). Proposta: ${prop.ore} ore a testa a chi sta prima e a chi sta dopo. Se ci sono altri accordi, aggiungi la persona che copre.`;
  // chi può essere aggiunto: chiunque in servizio, tranne il malato e chi è a sua volta in malattia quel giorno
  const inMal = new Set(stato.dati.shifts.filter((x) => x.date === data && x.kind === 'MU').map((x) => x.staff_id));
  const candidati = stato.dati.staff.filter((p) => p.id !== staffId && !inMal.has(p.id) && inServizio(p, +data.slice(0, 4), +data.slice(5, 7)));
  $('cop-chi').innerHTML = candidati.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('cop2-da').value = copertura.inizio; $('cop2-a').value = copertura.fine;
  disegnaProposte();
  $('dlg-copertura').showModal();
}
function disegnaProposte() {
  const voci = copertura.voci;
  $('cop-righe').innerHTML = voci.length
    ? voci.map((v, i) => `<label><input type="checkbox" data-i="${i}" checked><span><b>${esc(v.nome)}</b> (${v.ruolo}, ${dataEstesa(v.date)}): ${v.verbo} · ${v.inizio}–${v.fine}${v.scost ? ` · <b>${etichettaScostamento(v.scost)}</b> ore` : ''}</span></label>`).join('')
    : '<p>Non c\'è nessuno nel turno prima o dopo: aggiungi tu chi copre, oppure sistema a mano.</p>';
  $('cop-si').hidden = !voci.length;
  $('cop-no').textContent = 'Non ora';
}
$('cop-aggiungi').onclick = () => {
  const id = +$('cop-chi').value, da = $('cop2-da').value, a = $('cop2-a').value;
  if (!id) return;
  if (!da || !a || da === a) { alert('Indica l\'ora di inizio e di fine della copertura.'); return; }
  const nome = nomePersona(id);
  copertura.voci.push({ staffId: id, nome, date: copertura.data, kind: 'COP', inizio: da, fine: a, ruolo: 'altro accordo', verbo: `copre dalle ${da} alle ${a}` });
  disegnaProposte();
};
$('cop-no').onclick = () => $('dlg-copertura').close();
$('cop-si').onclick = async () => {
  const scelte = [...$('cop-righe').querySelectorAll('input:checked')].map((i) => copertura.voci[+i.dataset.i]);
  try {
    await stato.be.applicaCopertura(copertura.ctx?.report || null, copertura.ctx?.giorno || null, scelte);   // cambia gli orari, avvisa i colleghi, segna il giorno come fatto
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
