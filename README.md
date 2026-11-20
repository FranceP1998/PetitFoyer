# Turni Petit Foyer — fase 1

Foglio turni digitale (piano mensile con la grafica del foglio cartaceo, stampa A4 orizzontale,
accesso per coordinatrice e operatori). Costo: zero (GitHub Pages + Supabase gratuito).

**Prima di configurare qualsiasi cosa puoi provarla:** apri `index.html` da un server web (o dal
sito GitHub Pages appena attivato). Finché `js/config.js` è vuoto l'app gira in **modalità demo**,
con un piano di esempio di novembre 2026 (non è il piano vero) e senza account.

## Cosa c'è in questa fase

- Piano mensile: due righe per persona (M sopra, P sotto), sbarra della notte, R, R con R piccola a pedice
  (richiesto), F, trattino, permesso, ⊛ copertura spesa, RB, ultima colonna = 1° del mese dopo.
- Stampa (pulsante *Stampa*): A4 orizzontale, una pagina, colori chiari.
- Coordinatrice: *Modifica* (tocca una casella), *Eventi del mese* (collettivo, spesa, altro),
  osservazioni, *Pubblica* / *Riporta in bozza*.
- Operatori: vedono solo i mesi pubblicati, sola lettura, la loro riga è evidenziata.
- **Caselle protette:** ferie, permessi, riposi richiesti e turni richiesti non possono essere modificati né
  cancellati da Marie. Se serve cambiarli, Marie chiede il consenso dall'app; l'operatore accetta o rifiuta
  (banner in alto); se accetta, Marie può modificare quella casella per 24 ore. La regola è nel database
  (`supabase/schema.sql`, sezione 9), quindi vale anche fuori dall'app. Marie può inserirle, ma una volta
  inserite si tolgono solo con il consenso: un errore di battitura richiede quindi il consenso dell'operatore.
- Installabile sul telefono (PWA). Le notifiche arrivano nella fase 2.

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

### 3. Account
1. *Authentication → Users → Add user → Create new user*: email + password per ciascuna persona,
   con **Auto Confirm User** attivo. L'account si collega da solo al nome grazie all'email.
2. *Authentication → Sign In / Providers*: disattiva **Allow new users to sign up**
   (così nessun altro può registrarsi).
3. Consegna a ciascuno email e password; potranno cambiarla più avanti (fase 2).

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
css/print.css         stampa A4 orizzontale
js/grid.js            disegna il foglio (tabella)
js/app.js             schermate, modifica, eventi, pubblicazione
js/data.js            accesso ai dati: demo e Supabase
js/demo-data.js       piano di esempio (solo modalità demo)
js/config.js          URL e chiave Supabase
supabase/schema.sql   tabelle, ruoli, regole di accesso, ping
supabase/seed.sql     le 7 persone
.github/workflows/    ping anti-pausa
assets/logo.png       (facoltativo) logo da mettere in testa al foglio e alla stampa
```

## Personalizzare la grafica
Colori e spessori sono in `:root` di `css/app.css`. Per mettere il logo della Libellula salva
un file `assets/logo.png`: compare in testa al foglio e nella stampa.
