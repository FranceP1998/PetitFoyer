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
  dell'anno prima fino a mezzanotte (ora italiana, calcolata dal database, non dal dispositivo) del 20 del mese prima: è il termine per
  **inviarle**. Poi Marie ha tempo per rispondere fino a mezzanotte del **21**; passato il 21 le richieste ancora in attesa
  valgono come accettate (così gli operatori non guadagnano nulla a inviare tutto all'ultimo secondo).
  L'operatore clicca su un giorno della propria riga del foglio (o sul pulsante *Richieste*). Ognuno può inviarne al
  massimo 3 per mese (riposi e turni insieme). Il database **blocca**
  solo: giorno già occupato, turno già chiesto da un altro (vince chi chiede prima), troppi riposi nello stesso giorno
  (2; in estate 1). Le altre regole **avvisano** soltanto (mattina dopo un pomeriggio, più di due notti di fila, più di 4
  giorni di lavoro consecutivi, qualsiasi cosa il giorno dopo una notte, secondo riposo nello stesso giorno, in estate due
  riposi di fila): l'operatore può inviare comunque e Marie vede la richiesta in giallo ("critica"); per accettarla o
  rifiutarla scrive la motivazione (obbligatoria anche se rifiuta una richiesta normale). Dopo il 21 del mese prima le
  richieste non esaminate valgono come **accettate** (lo fa il database all'apertura dell'app). Tutti gli operatori vedono
  tutte le richieste, anche ferie e permessi, e nel mese non ancora pubblicato il foglio mostra solo ferie, permessi,
  riposi e turni richiesti (le richieste in attesa sono tratteggiate). Le regole sono nel database (sezione 16 di `schema.sql`).
- **Ferie e permessi:** si chiedono dallo stesso pulsante o cliccando sul giorno (tipo *Ferie* o *Permesso*, "dal giorno" e "fino al"), con la stessa finestra delle altre richieste e senza contare nelle 3 al mese. Le domeniche comprese nel periodo, anche se sono il primo o l'ultimo giorno, diventano da sole il trattino (per Marie anche i sabati, perché il suo contratto è senza weekend). Il database blocca i giorni già occupati e avvisa (richiesta in giallo per Marie) se in quei giorni sono già assenti almeno 2 colleghi. Marie accetta o rifiuta come per le altre richieste (motivazione se rifiuta o se è critica); passato il 21 valgono come accettate. Accettate diventano caselle protette.
- **Le ferie di Marie:** il pulsante *Le mie ferie* (solo per la coordinatrice) segna ferie o permessi dal primo all'ultimo giorno, senza richiesta né approvazione (funzione `mie_ferie` del database). Valgono i blocchi delle ferie degli operatori (giorno occupato, massimo 45 giorni); i sabati e le domeniche compresi nel periodo, anche a inizio e fine, diventano il trattino al posto della R. Le sue ferie non sono protette: con *Modifica* le toglie o le sposta da sola, senza consenso.
- **Weekend di Marie:** Marie ha il contratto senza sabato e domenica (colonna `senza_weekend` di `staff`, impostata dallo schema per la coordinatrice). Sul foglio e nel PDF i suoi sabati e domeniche vuoti mostrano la R di default, solo a video (non è salvata nel database), e sparisce se quel giorno c'è un altro turno o un'assenza.
- **Pulisci calendario (coordinatrice):** cancella tutti i turni e i riposi non protetti del mese in bozza (ferie, permessi, riposi richiesti, richieste accettate, malattie, 10-18, coperture e collettivi restano); chiede conferma.
- **Festività (coordinatrice):** il pulsante *Festività* apre l'elenco della **stagione** (dal 24 dicembre al 15 agosto dell'anno dopo, come un calendario scolastico; si scorre da una stagione all'altra con le frecce). Predefinito: 24 dicembre, Natale, Ultimo dell'anno, Capodanno, Epifania, Pasqua e Pasquetta (calcolate da sole), 25 aprile, 1 maggio, 2 giugno e Ferragosto; si possono aggiungere, rinominare e togliere date. Per ogni festività Marie sceglie chi fa mattina, pomeriggio e notte, subito dopo la riunione: ogni cambio si salva da solo e sotto compare quante festività ha avuto ognuno nell'anno, per tenerle bilanciate. I turni assegnati sono **fissi** (né *Pulisci calendario* né *Rifà tutto* li toccano, il generatore li tiene e ci costruisce il mese intorno, e i conflitti che nascono solo da loro non vengono segnalati) e **sempre visibili a tutti gli operatori**, anche nei mesi in bozza. L'assegnazione sostituisce i turni generati di quel giorno e il riposo obbligato della persona; viene rifiutata se la persona ha ferie, permesso, riposo richiesto o malattia, o se il turno è già richiesto da un altro, e nei mesi già pubblicati. Togliere una festività lascia i turni nel foglio come turni normali. Nel database: tabella `holidays`, colonna `shifts.festivo` e funzioni `imposta_festivita` e `togli_festivita`.
- **Genera bozza (coordinatrice):** il pulsante *Genera bozza* (solo nei mesi in bozza) propone M, P, N e i riposi del mese. Ogni volta chiede la modalità: **«Rifà tutto tranne le caselle protette»** (cancella turni e riposi non richiesti, anche scritti a mano, e ricompone il mese; chiede conferma) oppure **«Riempie solo le caselle vuote»** (quello che c'è resta). Ferie, permessi, riposi richiesti, richieste accettate e malattie non vengono mai toccati; il turno fisso settimanale di Andrea (martedì P, giovedì M, sabato notte + R del lunedì, impostabile in *Gestione personale*) viene rispettato e Andrea resta fuori dall'equilibrio dei turni e dei weekend. Il calcolo gira dentro l'app, senza librerie esterne né connessione: parte da un piano costruito turno per turno e lo migliora per tentativi (ricottura simulata, tre giri indipendenti, circa 30 secondi in tutto) tenendo il migliore, con gli stessi pesi per le regole. Regole obbligatorie: un solo operatore per turno, un solo turno al giorno, al massimo 2 notti di fila, R il giorno dopo la/le notte/i, 11 ore tra pomeriggio e mattina, al massimo 4 giorni di fila. Se il mese non permette di rispettarle tutte, il programma rinuncia alle regole in questo ordine (dalla prima a cadere all'ultima): 1) secondo weekend libero, 2) equilibrio di mattine/pomeriggi/notti nel mese e nell'anno, 3) doppie notti, 4) 4 giorni di fila (meglio 3), 5) alternanza dei turni nella settimana (lo stesso turno non si ripete: più si ripete, più costa), 6) sabato e domenica entrambi lavorati nello stesso weekend, 7) nessun weekend completamente libero nel mese, 8) più di 4 giorni di fila, 9) 11 ore, 10) riposo dopo la notte, 11) turno scoperto. In più la notte del venerdì sul sabato ha un piccolo costo suo (peso 25, poco sopra le doppie notti): meglio non darla, ma darla è quasi come un weekend libero. I pesi sono in `COSTI` all'inizio di `js/generatore.js`. Un weekend è «libero» se sabato e domenica sono entrambi senza lavoro; la notte del sabato occupa anche la domenica, mentre la notte del venerdì sul sabato conta come lavoro per i riposi e per i giorni di fila ma **non** toglie il weekend libero (si stacca alle 7 del sabato). **Calendario infinito:** il generatore non ragiona su un mese isolato. Usa gli ultimi giorni del mese prima (notti e riposi compresi, anche a cavallo d'anno), i turni M/P/N fatti dall'inizio dell'anno, i weekend liberi e le doppie notti di ognuno, e l'alternanza della settimana a cavallo dei mesi; chi è stato più penalizzato nei mesi scorsi viene compensato. **Anticipo:** il piano comprende anche il 1° giorno del mese dopo (comprese le notti che ci cadono), così il mese dopo parte già con un giorno impostato; se quel mese è già pubblicato non viene toccato. Nella griglia e nel PDF a sinistra c'è la colonna dell'ultimo giorno del mese prima e a destra quella del 1° del mese dopo: sono le stesse caselle dei rispettivi mesi, quindi si compilano da sole. *Genera bozza* e *Pulisci calendario* agiscono anche sul 1° del mese dopo (se non pubblicato). **Il 1° giorno di ogni mese è fisso:** i turni e i riposi scritti il 1° dal piano del mese prima non vengono mai cancellati né da *Pulisci calendario* né da *Rifà tutto* (gli operatori li conoscono già); il generatore li considera costanti e compila solo le eventuali caselle vuote di quel giorno. Nelle segnalazioni del riepilogo compaiono solo i conflitti in cui almeno un turno l'ha scelto il generatore: se il conflitto nasce solo da turni richiesti e accettati, da malattie o da turni già decisi dal mese prima, non viene segnalato (la segnalazione spetta al momento della richiesta). Prima di applicare c'è un riepilogo (turni per persona, weekend liberi, regole non rispettate); si può rigenerare per avere una variante. Le richieste ancora da esaminare non vengono considerate. La scrittura è atomica (`scrivi_piano` nel database) e i mesi pubblicati non si possono rigenerare.
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
js/generatore.js      generatore automatico dei turni (ricerca locale; il modello LP serve solo ai test)
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
