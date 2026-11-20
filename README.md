# Turni Petit Foyer — fase 1

Foglio turni digitale (piano mensile con la grafica del foglio cartaceo, PDF A4 orizzontale,
accesso per coordinatrice e operatori). Costo: zero (GitHub Pages + Supabase gratuito).

**Prima di configurare qualsiasi cosa puoi provarla:** apri `index.html` da un server web (o dal
sito GitHub Pages appena attivato). Finché `js/config.js` è vuoto l'app gira in **modalità demo**,
con un piano di esempio di novembre 2026 (non è il piano vero) e senza account.

## Cosa c'è in questa fase

- Piano mensile: due righe per persona (M sopra, P sotto), sbarra della notte, R, R con R piccola a pedice
  (richiesto), F, trattino, permesso, ⊛ copertura spesa, RB, ultima colonna = 1° del mese dopo.
- **Salva PDF** (pulsante in alto): crea un PDF A4 orizzontale, una pagina, centrato e con colori chiari, da salvare
  sul computer o sul telefono e stampare da lì (su telefono si apre il menu *Salva su File / Stampa / Condividi*).
- Coordinatrice: *Modifica* (tocca una casella), *Eventi del mese* (collettivo, spesa, altro),
  osservazioni, *Pubblica* / *Riporta in bozza*.
- Operatori: vedono solo i mesi pubblicati, sola lettura, la loro riga è evidenziata.
- **Caselle protette:** ferie, permessi, riposi richiesti e turni richiesti non possono essere modificati né
  cancellati da Marie. Se serve cambiarli, Marie chiede il consenso dall'app; l'operatore accetta o rifiuta
  (banner in alto); se accetta, Marie può modificare quella casella per 24 ore. La regola è nel database
  (`supabase/schema.sql`, sezione 9), quindi vale anche fuori dall'app. Marie può inserirle, ma una volta
  inserite si tolgono solo con il consenso: un errore di battitura richiede quindi il consenso dell'operatore.
- **Comunica malattia** (operatore): scrive primo e ultimo giorno del medico, vede l'anteprima e conferma. Sui giorni
  con un turno compare MU (riposi, ferie e permessi non si toccano; per le notti conta il giorno in cui inizia);
  si salvano solo le date. Marie riceve la notifica nell'app e per ogni turno sceglie la copertura: la proposta (+4 ore a chi
  sta prima e a chi sta dopo) oppure un altro accordo (aggiunge la persona che copre, con i suoi orari). Solo allora i
  colleghi ricevono la loro notifica e quel giorno risulta fatto da solo; a giorni finiti la segnalazione sparisce. Le regole sono nel database (sezione 15 di `schema.sql`).
- **Richieste di riposo o di turno:** sono sempre aperte, senza che Marie debba aprirle: per ogni mese dal 1 ottobre
  dell'anno prima fino a mezzanotte (ora italiana, calcolata dal database, non dal dispositivo) del 20 del mese prima.
  L'operatore clicca su un giorno della propria riga del foglio (o sul pulsante *Richieste*). Ognuno può inviarne al
  massimo 3 per mese (riposi e turni insieme). Il database **blocca**
  solo: giorno già occupato, turno già chiesto da un altro (vince chi chiede prima), troppi riposi nello stesso giorno
  (2; in estate 1). Le altre regole **avvisano** soltanto (mattina dopo un pomeriggio, più di due notti di fila, più di 4
  giorni di lavoro consecutivi, qualsiasi cosa il giorno dopo una notte, secondo riposo nello stesso giorno, in estate due
  riposi di fila): l'operatore può inviare comunque e Marie vede la richiesta in giallo ("critica"); per accettarla o
  rifiutarla scrive la motivazione (obbligatoria anche se rifiuta una richiesta normale). Dopo il 20 del mese prima le
  richieste non esaminate valgono come **accettate** (lo fa il database all'apertura dell'app). Tutti gli operatori vedono
  tutte le richieste, anche ferie e permessi, e nel mese non ancora pubblicato il foglio mostra solo ferie, permessi,
  riposi e turni richiesti (le richieste in attesa sono tratteggiate). Le regole sono nel database (sezione 16 di `schema.sql`).
- **Notifiche:** campanella in alto (grigia se non ce ne sono, con pallino rosso e numero se ce ne sono): si apre un menu con l'elenco, "Letta" per ognuna o "Segna tutte come lette".
- Installabile sul telefono (PWA). Notifiche nell'app già attive per la malattia; le email e le notifiche sul telefono arrivano nei prossimi passi della fase 2.

## Installazione (circa 30 minuti)

### 1. GitHub
1. Crea un repository **pubblico** chiamato, per esempio, `turni-petit-foyer`.
2. *Add file → Upload files* e carica tutto il contenuto di questa cartella (comprese `.github` e `.nojekyll`;
   se il caricamento dal browser salta le cartelle nascoste, crea `.github/workflows/keepalive.yml` a mano
   incollando il contenuto).
3. *Settings → Pages → Build and deployment*: Source = *Deploy from a branch*, Branch = `main`, cartella `/ (root)`.
   Dopo un minuto il sito è su `https://TUO-NOME.github.io/turni-petit-foyer/`.

Nel repository c'è solo il codice: **nessun dato dei lavoratori**.

### 2. Supabase
1. Su supabase.com crea un account e un *New project*. Regione: **un'area europea** (per esempio Frankfurt).
   Annota la password del database in un posto sicuro.
2. *SQL Editor → New query*: incolla tutto `supabase/schema.sql` → *Run*.
3. Nuova query: incolla `supabase/seed.sql` → *Run* (crea le 7 persone).
4. *Table editor → staff*: sostituisci le email finte con le email vere di ciascuno
   (servono per collegare l'account al nome).

### 3. Accesso delle persone (nessuna password da distribuire)
1. *Authentication → Sign In / Providers → Email*: **Confirm email** attivo; lascia **Allow new users to sign up**
   attivo (a chi non è nell'elenco lo impedisce il database). Password minima: 8 caratteri.
   Se c'è l'opzione **Secure password change**, attivala.
2. *Authentication → Email → SMTP Settings*: invio con un indirizzo dedicato (per esempio Gmail con
   password per app: `smtp.gmail.com`, porta 465). Senza SMTP proprio Supabase invia solo ai membri del team.
3. *Authentication → Email Templates*: in **Confirm signup**, **Magic Link**, **Reset Password** e
   **Reauthentication** il testo deve contenere il codice `{{ .Token }}` (6 cifre).
4. Il **primo accesso** lo fa ciascuno da solo: *Primo accesso o password dimenticata* → email → codice ricevuto →
   sceglie la propria password. Funziona solo per le email scritte in *Gestione personale* (o nella tabella `staff`).
5. Dentro l'app, *Cambia password* invia un nuovo codice via email. La password dimenticata si recupera con lo stesso
   percorso del primo accesso.
6. Marie aggiunge e toglie gli operatori da **Gestione personale** (con la data di fine servizio: i mesi passati restano
   com'erano). Non può creare coordinatrici né cambiare ruoli: si fa solo dal pannello di Supabase.

### 4. Collega l'app al database
1. *Project Settings → API*: copia **Project URL** e la chiave **anon / public**.
2. In GitHub apri `js/config.js` (icona matita), incollali in `SUPABASE_URL` e `SUPABASE_ANON_KEY`, *Commit*.
   (La chiave anon è pensata per essere pubblica: i dati sono protetti dalle regole di accesso per riga.)

### 5. Ping anti-pausa
Il progetto gratuito va in pausa dopo circa una settimana senza attività.
1. In GitHub: *Settings → Secrets and variables → Actions → New repository secret*:
   `SUPABASE_URL` e `SUPABASE_ANON_KEY` (gli stessi due valori).
2. *Actions → Ping Supabase (anti-pausa) → Run workflow*: deve finire con la spunta verde.
   Da allora parte da solo ogni 3 giorni (e un secondo giro ogni 4).
3. **Ping di riserva (consigliato):** GitHub disattiva le azioni pianificate dopo 60 giorni senza
   modifiche al repository. Su cron-job.org (gratuito) crea un lavoro ogni 2 giorni: `POST` a
   `SUPABASE_URL/rest/v1/rpc/ping`, con header `apikey` e `Authorization: Bearer <anon key>`, corpo `{}`.
4. Una volta ogni tanto esporta i dati (*Table editor → Export*), perché il piano gratuito non fa backup automatici.

### 6. Prima prova
Apri il sito → accedi come Marie → vai al mese → *Modifica* → tocca le caselle → *Eventi del mese* →
*Pubblica*. Poi accedi da un altro dispositivo come operatore e controlla che veda il piano.

**iPhone:** apri il sito in Safari → Condividi → *Aggiungi a Home*. **Android:** menu di Chrome → *Installa app*.

## Struttura

```
index.html            pagina unica
css/app.css           aspetto a schermo e colori (variabili in :root)
css/print.css         stampa diretta dal browser (di riserva: si consiglia Salva PDF)
js/grid.js            disegna il foglio (tabella)
js/app.js             schermate, modifica, eventi, pubblicazione
js/data.js            accesso ai dati: demo e Supabase
js/demo-data.js       piano di esempio (solo modalità demo)
js/config.js          URL e chiave Supabase
supabase/schema.sql   tabelle, ruoli, regole di accesso, ping
supabase/seed.sql     le 7 persone
.github/workflows/    ping anti-pausa
assets/logo.png       (facoltativo) logo da mettere in testa al foglio a schermo
```

## Personalizzare la grafica
Colori e spessori sono in `:root` di `css/app.css`. Per mettere il logo della Libellula salva
un file `assets/logo.png`: compare in testa al foglio a schermo (nel PDF per ora c'è solo il nome della cooperativa).
