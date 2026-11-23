-- =====================================================================
-- Turni Petit Foyer — schema database (fase 1)
-- Da incollare ed eseguire una sola volta in Supabase > SQL Editor.
-- È pensato per essere rieseguibile senza danni (create if not exists).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Persone (operatori + coordinatrice)
-- ---------------------------------------------------------------------
create table if not exists public.staff (
  id             bigint generated always as identity primary key,
  name           text not null,
  email          text unique,                       -- serve per collegare l'account al nome
  user_id        uuid unique references auth.users(id) on delete set null,
  role           text not null default 'operator' check (role in ('coordinator','operator')),
  sort_order     int  not null default 100,         -- ordine delle righe nel foglio
  active         boolean not null default true,
  fixed_pattern  boolean not null default false,    -- true per Andrea (turni fissi)
  contract_hours numeric,                           -- ore di contratto mensili (le inserisce la coordinatrice)
  start_date     date,                              -- primo giorno in servizio (vuoto = da sempre)
  end_date       date,                              -- ultimo giorno in servizio (vuoto = ancora in servizio)
  created_at     timestamptz not null default now()
);
alter table public.staff add column if not exists start_date date;
alter table public.staff add column if not exists end_date   date;
-- contratto senza sabato e domenica (solo Marie): nel foglio quei giorni sono R di default e,
-- dentro ferie e permessi, sia il sabato sia la domenica diventano il trattino
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'senza_weekend') then
    alter table public.staff add column senza_weekend boolean not null default false;
    update public.staff set senza_weekend = true where role = 'coordinator';
  end if;
end $$;
-- schema settimanale di chi ha i turni fissi: giorno della settimana (0 = domenica ... 6 = sabato) -> M, P o N.
-- Lo scrive la coordinatrice in Gestione personale; il generatore lo usa come dato fisso.
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'fixed_days') then
    alter table public.staff add column fixed_days jsonb not null default '{}'::jsonb;
    update public.staff set fixed_days = '{"2":"P","4":"M","6":"N"}'::jsonb where fixed_pattern and name = 'Andrea';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Mesi (bozza / pubblicato) e osservazioni
-- ---------------------------------------------------------------------
create table if not exists public.months (
  year         int not null,
  month        int not null check (month between 1 and 12),
  status       text not null default 'draft' check (status in ('draft','published')),
  notes        text not null default '',            -- campo "Osservazioni" in fondo al foglio
  published_at timestamptz,
  primary key (year, month)
);

-- ---------------------------------------------------------------------
-- 3. Celle del foglio: una riga per (persona, giorno, tipo)
--    M, P       = mattina, pomeriggio
--    N          = notte che INIZIA quel giorno (occupa quel giorno e il successivo)
--    R          = riposo obbligatorio dopo la notte
--    RR         = riposo richiesto
--    F          = ferie        FS = domenica compresa nelle ferie (trattino)
--    PERM       = permesso (giorno intero)
--    SPESA      = copertura spesa (10-12, 2 ore)
--    RB         = recupero ore
--    T1018      = turno 10-18 (occupa il giorno, rispetta tutte le regole come gli altri turni)
--    MU         = malattia (mutua): il turno M/P/N della persona resta registrato sotto, non si disegna
--    COP        = copertura con orari scelti dalla coordinatrice (start_time/end_time): non occupa
--                 il giorno e non richiede le 11 ore di stacco
--    requested  = vero se il turno (M, P, N) è stato richiesto dall'operatore
--    start_time / end_time = orari effettivi, quando diversi dallo standard (copertura, e in futuro
--                 gli allungamenti concordati tra colleghi o le coperture per malattia)
-- ---------------------------------------------------------------------
create table if not exists public.shifts (
  id          bigint generated always as identity primary key,
  staff_id    bigint not null references public.staff(id) on delete cascade,
  date        date   not null,
  kind        text   not null,
  requested   boolean not null default false,
  start_time  time,
  end_time    time,
  inserted_at timestamptz not null default now(),   -- serve per la precedenza (chi ha chiesto prima)
  inserted_by uuid default auth.uid(),
  unique (staff_id, date, kind)
);
-- (le righe seguenti rendono il file rieseguibile anche su un database già creato con la versione precedente)
alter table public.shifts add column if not exists start_time time;
alter table public.shifts add column if not exists end_time   time;
alter table public.shifts drop constraint if exists shifts_kind_check;
alter table public.shifts add constraint shifts_kind_check
  check (kind in ('M','P','N','R','RR','F','FS','PERM','SPESA','RB','T1018','COP','MU'));
alter table public.shifts drop constraint if exists shifts_cop_orari;
alter table public.shifts add constraint shifts_cop_orari
  check (kind <> 'COP' or (start_time is not null and end_time is not null and start_time <> end_time));
create index if not exists shifts_date_idx on public.shifts (date);

-- ---------------------------------------------------------------------
-- 4. Eventi di servizio (collettivo, giorni di copertura spesa, altro)
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  date       date not null,
  kind       text not null check (kind in ('collettivo','spesa','altro')),
  label      text not null default '',
  start_time time,
  end_time   time
);
create index if not exists events_date_idx on public.events (date);

-- ---------------------------------------------------------------------
-- 5. Ping anti-pausa (vedi .github/workflows/keepalive.yml)
-- ---------------------------------------------------------------------
create table if not exists public.keepalive (
  id        int primary key default 1 check (id = 1),
  last_ping timestamptz not null default now()
);

create or replace function public.ping()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.keepalive (id, last_ping) values (1, now())
  on conflict (id) do update set last_ping = excluded.last_ping
  returning last_ping;
$$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Collegamento automatico account <-> persona (per email)
--    Quando crei un utente in Authentication > Users, se l'email coincide
--    con quella scritta nella tabella staff, l'account viene collegato da solo.
-- ---------------------------------------------------------------------
create or replace function public.link_staff_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.staff
     set user_id = new.id
   where lower(email) = lower(new.email)
     and user_id is null
     and active;
  return new;
end;
$$;

-- Il collegamento avviene solo quando l'email risulta CONFERMATA (cioè quando chi ha
-- l'accesso alla casella ha inserito il codice ricevuto): nessuno può "prenotare" il posto di un altro.
drop trigger if exists on_auth_user_created_link_staff on auth.users;
create trigger on_auth_user_created_link_staff
  after insert or update of email_confirmed_at on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.link_staff_on_signup();

-- ---------------------------------------------------------------------
-- 7. Funzioni di appoggio per le regole di accesso
-- ---------------------------------------------------------------------
create or replace function public.is_coordinator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where user_id = auth.uid() and role = 'coordinator' and active
       and (end_date is null or end_date >= current_date)
  );
$$;

create or replace function public.is_staff_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff where user_id = auth.uid() and active
       and (end_date is null or end_date >= current_date)
  );
$$;

-- Il mese di una data è pubblicato? (il primo giorno del mese dopo conta come
-- parte del mese pubblicato, perché compare nell'ultima colonna del foglio)
create or replace function public.is_published(d date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.months m
     where m.status = 'published'
       and (
            (m.year = extract(year from d)::int and m.month = extract(month from d)::int)
         or (extract(day from d) = 1
             and m.year  = extract(year  from (d - 1))::int
             and m.month = extract(month from (d - 1))::int)
       )
  );
$$;

-- ---------------------------------------------------------------------
-- 8. Regole di accesso per riga (Row Level Security)
--    Fase 1: tutti i membri leggono (gli operatori solo i mesi pubblicati);
--    scrive solo la coordinatrice.
-- ---------------------------------------------------------------------
alter table public.staff     enable row level security;
alter table public.months    enable row level security;
alter table public.shifts    enable row level security;
alter table public.events    enable row level security;
alter table public.keepalive enable row level security;   -- nessuna policy: non leggibile da fuori

drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff
  for select to authenticated
  using (public.is_staff_member());

drop policy if exists staff_write on public.staff;
create policy staff_write on public.staff
  for all to authenticated
  using (public.is_coordinator()) with check (public.is_coordinator());

drop policy if exists months_select on public.months;
create policy months_select on public.months
  for select to authenticated
  using (public.is_coordinator() or (public.is_staff_member() and status = 'published'));

drop policy if exists months_write on public.months;
create policy months_write on public.months
  for all to authenticated
  using (public.is_coordinator()) with check (public.is_coordinator());

drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated
  using (public.is_coordinator() or (public.is_staff_member() and public.is_published(date)));

drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts
  for all to authenticated
  using (public.is_coordinator()) with check (public.is_coordinator());

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated
  using (public.is_coordinator() or (public.is_staff_member() and public.is_published(date)));

drop policy if exists events_write on public.events;
create policy events_write on public.events
  for all to authenticated
  using (public.is_coordinator()) with check (public.is_coordinator());

-- ---------------------------------------------------------------------
-- 9. Caselle PROTETTE e consenso dell'operatore
--    Sono protette: ferie (F, FS), permessi (PERM), riposi richiesti (RR) e
--    turni richiesti (requested = true). La coordinatrice può inserirle ma NON
--    modificarle né cancellarle, salvo consenso dell'operatore interessato:
--      1. lei chiede il consenso (chiedi_sblocco)
--      2. l'operatore accetta o rifiuta nell'app (rispondi_sblocco)
--      3. se accetta, la casella si può modificare per 24 ore, poi si richiude
--    La regola è imposta dal database, non solo dalla schermata.
-- ---------------------------------------------------------------------
create table if not exists public.unlocks (
  id           bigint generated always as identity primary key,
  staff_id     bigint not null references public.staff(id) on delete cascade,
  date         date   not null,
  kinds        text   not null default '',          -- cosa c'è nella casella (per il messaggio all'operatore)
  status       text   not null default 'pending'
               check (status in ('pending','approved','rejected','used','cancelled')),
  requested_by uuid   default auth.uid(),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index if not exists unlocks_cell_idx on public.unlocks (staff_id, date);

create or replace function public.is_protected_row(p_kind text, p_requested boolean)
returns boolean
language sql
immutable
as $$ select p_kind in ('F','FS','PERM','RR') or coalesce(p_requested, false); $$;

-- Blocca modifica e cancellazione delle righe protette senza consenso valido (24 ore)
create or replace function public.shifts_protect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- le ferie e i permessi della coordinatrice sono suoi: li sposta e li toglie da sola, senza consenso di nessuno
  if public.is_coordinator() and old.staff_id = public.mia_persona() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if public.is_protected_row(old.kind, old.requested) then
    -- se cambiano solo gli orari di un turno M/P/N (es. copertura di una malattia) non serve il consenso
    if tg_op = 'UPDATE' and old.kind in ('M','P','N') and new.kind = old.kind
       and new.requested = old.requested and new.staff_id = old.staff_id and new.date = old.date then
      return new;
    end if;
    if not exists (
      select 1 from public.unlocks u
       where u.staff_id = old.staff_id
         and u.date = old.date
         and u.status = 'approved'
         and u.decided_at > now() - interval '24 hours'
    ) then
      raise exception 'Casella protetta (ferie, permesso o richiesta accettata): serve il consenso dell''operatore.'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists shifts_protect_trg on public.shifts;
create trigger shifts_protect_trg
  before update or delete on public.shifts
  for each row execute function public.shifts_protect();

-- La coordinatrice chiede il consenso per una casella
create or replace function public.chiedi_sblocco(p_staff bigint, p_date date)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint; v_kinds text;
begin
  if not public.is_coordinator() then
    raise exception 'Solo la coordinatrice può chiedere un consenso.' using errcode = '42501';
  end if;
  select id into v_id from public.unlocks
   where staff_id = p_staff and date = p_date and status = 'pending' limit 1;
  if v_id is not null then return v_id; end if;
  select string_agg(kind, ',' order by kind) into v_kinds
    from public.shifts
   where staff_id = p_staff and date = p_date and public.is_protected_row(kind, requested);
  insert into public.unlocks (staff_id, date, kinds) values (p_staff, p_date, coalesce(v_kinds, ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- L'operatore accetta o rifiuta (solo per le proprie caselle)
create or replace function public.rispondi_sblocco(p_id bigint, p_accetta boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.unlocks u
     set status = case when p_accetta then 'approved' else 'rejected' end,
         decided_at = now()
   where u.id = p_id
     and u.status = 'pending'
     and u.staff_id in (select s.id from public.staff s where s.user_id = auth.uid());
  if not found then
    raise exception 'Richiesta non trovata o già decisa.' using errcode = '42501';
  end if;
end;
$$;

-- La coordinatrice segna il consenso come usato, o ritira una richiesta
create or replace function public.chiudi_sblocco(p_staff bigint, p_date date, p_nuovo_stato text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_coordinator() then
    raise exception 'Solo la coordinatrice.' using errcode = '42501';
  end if;
  if p_nuovo_stato not in ('used','cancelled') then
    raise exception 'Stato non valido.';
  end if;
  update public.unlocks
     set status = p_nuovo_stato
   where staff_id = p_staff and date = p_date and status in ('pending','approved');
end;
$$;

revoke all on function public.chiedi_sblocco(bigint, date) from public;
revoke all on function public.rispondi_sblocco(bigint, boolean) from public;
revoke all on function public.chiudi_sblocco(bigint, date, text) from public;
grant execute on function public.chiedi_sblocco(bigint, date) to authenticated;
grant execute on function public.rispondi_sblocco(bigint, boolean) to authenticated;
grant execute on function public.chiudi_sblocco(bigint, date, text) to authenticated;

alter table public.unlocks enable row level security;
drop policy if exists unlocks_select on public.unlocks;
create policy unlocks_select on public.unlocks
  for select to authenticated
  using (
    public.is_coordinator()
    or staff_id in (select s.id from public.staff s where s.user_id = auth.uid())
  );
-- nessuna policy di scrittura: si scrive solo tramite le tre funzioni qui sopra

-- ---------------------------------------------------------------------
-- 10. Dati riservati della tabella staff
--     Gli operatori vedono nomi e ruoli (servono per disegnare il foglio) ma NON
--     le email dei colleghi né le ore di contratto. Queste colonne le legge solo
--     chi usa la dashboard di Supabase (Table editor); in fase 2 la coordinatrice
--     le leggerà tramite una funzione dedicata.
-- ---------------------------------------------------------------------
revoke select on public.staff from anon, authenticated;
grant select (id, name, role, sort_order, active, fixed_pattern, user_id, start_date, end_date, senza_weekend, fixed_days) on public.staff to authenticated;

-- ---------------------------------------------------------------------
-- 11. Registrazione consentita SOLO alle email scritte nella tabella staff
--     Il "primo accesso" dell'app crea l'account (codice ricevuto per email, poi scelta della
--     password): il database rifiuta qualsiasi email che Marie non abbia inserito in "Gestione personale".
-- ---------------------------------------------------------------------
create or replace function public.guard_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.staff
     where lower(email) = lower(new.email) and active and user_id is null
       and (end_date is null or end_date >= current_date)
  ) then
    raise exception 'Questo indirizzo email non è tra quelli abilitati.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_guard on auth.users;
create trigger on_auth_user_guard
  before insert on auth.users
  for each row execute function public.guard_signup();

-- ---------------------------------------------------------------------
-- 12. "Gestione personale" (solo coordinatrice)
--     Marie può aggiungere operatori, modificarne i dati e fissare la data di fine servizio.
--     NON può: creare altre coordinatrici, cambiare ruoli o collegamenti agli account,
--     disattivare se stessa, eliminare persone che hanno già accesso o turni.
--     (Dal pannello di Supabase, invece, chi amministra il sistema può fare tutto.)
-- ---------------------------------------------------------------------
create or replace function public.staff_protect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then                                   -- pannello Supabase / amministrazione
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role <> 'operator' then
      raise exception 'Da qui si possono aggiungere solo operatori.' using errcode = '42501';
    end if;
    new.user_id := null;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      raise exception 'Il ruolo non si cambia da qui.' using errcode = '42501';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'Il collegamento con l''account non si cambia da qui.' using errcode = '42501';
    end if;
    if new.email is distinct from old.email and old.user_id is not null then
      raise exception 'L''email di chi ha già fatto il primo accesso non si cambia da qui.' using errcode = '42501';
    end if;
    if old.user_id = auth.uid() and (new.active is distinct from old.active or new.end_date is distinct from old.end_date) then
      raise exception 'Non puoi disattivare il tuo stesso account.' using errcode = '42501';
    end if;
    return new;
  else
    if old.user_id is not null or exists (select 1 from public.shifts where staff_id = old.id) then
      raise exception 'Una persona con accesso o con turni non si elimina: imposta la data di fine servizio.' using errcode = '42501';
    end if;
    return old;
  end if;
end;
$$;

drop trigger if exists staff_protect_trg on public.staff;
create trigger staff_protect_trg
  before insert or update or delete on public.staff
  for each row execute function public.staff_protect();

-- Elenco completo (con email e ore di contratto): lo vede solo la coordinatrice
drop function if exists public.elenco_personale();
create or replace function public.elenco_personale()
returns table (
  id bigint, name text, email text, role text, sort_order int, active boolean,
  fixed_pattern boolean, contract_hours numeric, start_date date, end_date date, ha_accesso boolean,
  senza_weekend boolean, fixed_days jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.email, s.role, s.sort_order, s.active, s.fixed_pattern,
         s.contract_hours, s.start_date, s.end_date, (s.user_id is not null), s.senza_weekend, s.fixed_days
    from public.staff s
   where public.is_coordinator()
   order by s.sort_order, s.name;
$$;
revoke all on function public.elenco_personale() from public;
grant execute on function public.elenco_personale() to authenticated;

-- ---------------------------------------------------------------------
-- 13. Permessi sulle tabelle per la Data API (l'app parla col database così)
--     Si assegnano tabella per tabella, così il progetto funziona anche con l'opzione
--     "Grant API access to new tables automatically" DISATTIVATA (scelta consigliata).
--     Chi non ha fatto l'accesso (anon) non ha alcun permesso sulle tabelle; chi lo ha fatto
--     può comunque fare solo ciò che le regole di accesso per riga (sezioni 8 e 9) consentono.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
revoke all on public.staff, public.months, public.shifts, public.events, public.unlocks, public.keepalive from anon, authenticated;
grant select, insert, update, delete on public.months, public.shifts, public.events to authenticated;
grant select on public.unlocks to authenticated;
grant select (id, name, role, sort_order, active, fixed_pattern, user_id, start_date, end_date, senza_weekend, fixed_days) on public.staff to authenticated;
grant insert, update, delete on public.staff to authenticated;

-- ---------------------------------------------------------------------
-- 14. Un giorno, un solo turno principale
--     Una persona non può avere nello stesso giorno due tra: M, P, N, R, RR, F, FS, PERM, 10-18.
--     Si aggiungono liberamente la copertura (COP), la copertura spesa, il recupero ore (RB)
--     e la malattia (MU, che accompagna il turno saltato).
-- ---------------------------------------------------------------------
create or replace function public.shifts_esclusivi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind in ('M','P','N','R','RR','F','FS','PERM','T1018') and exists (
    select 1 from public.shifts s
     where s.staff_id = new.staff_id and s.date = new.date
       and s.id is distinct from new.id
       and s.kind in ('M','P','N','R','RR','F','FS','PERM','T1018')
  ) then
    raise exception 'In un giorno si può avere un solo turno principale (M, P, N, riposo, ferie, permesso, 10-18).'
      using errcode = '23514';
  end if;
  -- la malattia non va insieme a ferie, riposi e permessi
  if (new.kind = 'MU' and exists (
        select 1 from public.shifts s
         where s.staff_id = new.staff_id and s.date = new.date and s.kind in ('R','RR','F','FS','PERM')))
     or (new.kind in ('R','RR','F','FS','PERM') and exists (
        select 1 from public.shifts s
         where s.staff_id = new.staff_id and s.date = new.date and s.kind = 'MU' and s.id is distinct from new.id)) then
    raise exception 'La malattia non si mette insieme a ferie, riposi o permessi.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists shifts_esclusivi_trg on public.shifts;
create trigger shifts_esclusivi_trg
  before insert or update of kind, staff_id, date on public.shifts
  for each row execute function public.shifts_esclusivi();

-- ---------------------------------------------------------------------
-- 15. Malattia comunicata dall'operatore + notifiche nell'app
--     L'operatore scrive solo il primo e l'ultimo giorno indicati dal medico. Il database:
--       - mette MU sui giorni in cui aveva un turno (M, P, N, 10-18, copertura, spesa, recupero ore);
--         i giorni con soli riposi, ferie o permessi (o vuoti) non si toccano;
--         per le notti conta il giorno in cui la notte INIZIA;
--       - registra la comunicazione (SOLO le date: niente certificato, niente diagnosi);
--       - avvisa la coordinatrice nell'app.
--     I colleghi che coprono ricevono la notifica SOLO quando la coordinatrice conferma la copertura.
--     Tutto passa da queste funzioni: nessuno scrive direttamente nelle tabelle.
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  staff_id   bigint not null references public.staff(id) on delete cascade,   -- destinatario
  kind       text   not null,
  text       text   not null,
  data       jsonb  not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  emailed_at timestamptz                                -- sarà usata dall'invio email (passo successivo)
);
create index if not exists notifications_dest_idx on public.notifications (staff_id, read_at);

create table if not exists public.sick_reports (
  id         bigint generated always as identity primary key,
  staff_id   bigint not null references public.staff(id) on delete cascade,
  first_day  date   not null,
  last_day   date   not null check (last_day >= first_day),
  days       jsonb  not null default '[]'::jsonb,       -- [{"date": "2026-11-06", "kind": "M"}, ...] turni saltati
  status     text   not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);

-- Quali giorni diventano MU: giorni con un'attività e senza riposi/ferie/permessi, non già in malattia
create or replace function public.giorni_malattia(p_staff bigint, p_from date, p_to date)
returns table (giorno date, saltato text)
language sql
stable
security definer
set search_path = public
as $$
  select s.date,
         (array_agg(s.kind order by array_position(array['M','P','N','T1018','COP','SPESA','RB'], s.kind))
            filter (where s.kind in ('M','P','N','T1018','COP','SPESA','RB')))[1]
    from public.shifts s
   where s.staff_id = p_staff and s.date between p_from and p_to
   group by s.date
  having bool_or(s.kind in ('M','P','N','T1018','COP','SPESA','RB'))
     and not bool_or(s.kind in ('R','RR','F','FS','PERM','MU'))
$$;
revoke all on function public.giorni_malattia(bigint, date, date) from public;

create or replace function public.mia_persona()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select id from public.staff
   where user_id = auth.uid() and active and (end_date is null or end_date >= current_date);
$$;
revoke all on function public.mia_persona() from public;

create or replace function public.controlla_periodo_malattia(p_from date, p_to date)
returns void
language plpgsql
as $$
begin
  if p_from is null or p_to is null then raise exception 'Scrivi il primo e l''ultimo giorno.' using errcode = '22023'; end if;
  if p_to < p_from then raise exception 'L''ultimo giorno non può essere prima del primo.' using errcode = '22023'; end if;
  if p_to - p_from > 59 then raise exception 'Il periodo è troppo lungo (massimo 60 giorni): per periodi più lunghi avvisa Marie.' using errcode = '22023'; end if;
  if p_from < current_date - 60 then raise exception 'Il primo giorno è troppo indietro nel tempo: avvisa Marie.' using errcode = '22023'; end if;
end;
$$;
revoke all on function public.controlla_periodo_malattia(date, date) from public;

-- Anteprima: cosa cambierebbe (senza modificare nulla). Dei piani non ancora pubblicati si dice solo quanti giorni.
create or replace function public.anteprima_malattia(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_staff bigint := public.mia_persona(); v_pub jsonb; v_bozza int;
begin
  if v_staff is null then raise exception 'Accesso non valido.' using errcode = '42501'; end if;
  perform public.controlla_periodo_malattia(p_from, p_to);
  select coalesce(jsonb_agg(jsonb_build_object('date', giorno, 'kind', saltato) order by giorno) filter (where public.is_published(giorno)), '[]'::jsonb),
         count(*) filter (where not public.is_published(giorno))
    into v_pub, v_bozza
    from public.giorni_malattia(v_staff, p_from, p_to);
  return jsonb_build_object('giorni', v_pub, 'giorni_bozza', v_bozza);
end;
$$;

-- Comunicazione vera e propria
create or replace function public.comunica_malattia(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_staff bigint := public.mia_persona(); v_nome text; v_days jsonb; v_id bigint; v_n int;
begin
  if v_staff is null then raise exception 'Accesso non valido.' using errcode = '42501'; end if;
  perform public.controlla_periodo_malattia(p_from, p_to);
  select name into v_nome from public.staff where id = v_staff;

  select coalesce(jsonb_agg(jsonb_build_object('date', giorno, 'kind', saltato) order by giorno), '[]'::jsonb)
    into v_days from public.giorni_malattia(v_staff, p_from, p_to);
  v_n := jsonb_array_length(v_days);
  if v_n = 0 then
    return jsonb_build_object('id', null, 'giorni', v_days);           -- niente da modificare: nessun turno in quel periodo
  end if;

  insert into public.shifts (staff_id, date, kind)
  select v_staff, (x->>'date')::date, 'MU' from jsonb_array_elements(v_days) x;

  insert into public.sick_reports (staff_id, first_day, last_day, days)
  values (v_staff, p_from, p_to, v_days) returning id into v_id;

  insert into public.notifications (staff_id, kind, text, data)
  select c.id, 'malattia',
         v_nome || ' ha comunicato malattia dal ' || to_char(p_from, 'DD/MM') || ' al ' || to_char(p_to, 'DD/MM')
           || ': ' || v_n || case when v_n = 1 then ' turno da coprire.' else ' turni da coprire.' end
           || ' Scegli le coperture.',
         jsonb_build_object('report', v_id, 'staff', v_staff)
    from public.staff c
   where c.role = 'coordinator' and c.active and c.id <> v_staff
     and (c.end_date is null or c.end_date >= current_date);

  return jsonb_build_object('id', v_id, 'giorni', v_days);
end;
$$;

-- La coordinatrice applica la copertura di un giorno di malattia: orari cambiati ai colleghi vicini
-- e/o altre persone messe in copertura (COP) per accordi presi. SOLO ora i colleghi ricevono la notifica.
-- Il giorno risulta "fatto" da solo; quando tutti i giorni della malattia sono fatti, la segnalazione si chiude.
-- p_voci = [{"staff": 5, "date": "2026-11-07", "kind": "M"|"P"|"N"|"COP", "start": "07:00", "end": "19:00"}, ...]
-- (può essere vuoto: "già sistemata" / nessuna copertura). Senza p_report si applicano solo le voci.
drop function if exists public.conferma_copertura(bigint, date, text, time, time);
create or replace function public.applica_copertura(p_report bigint, p_giorno date, p_voci jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb; v_staff bigint; v_date date; v_kind text; v_s time; v_e time; v_days jsonb; v_aperti int;
begin
  if not public.is_coordinator() then
    raise exception 'Solo la coordinatrice.' using errcode = '42501';
  end if;
  for v in select * from jsonb_array_elements(coalesce(p_voci, '[]'::jsonb)) loop
    v_staff := (v->>'staff')::bigint; v_date := (v->>'date')::date; v_kind := v->>'kind';
    v_s := (v->>'start')::time; v_e := (v->>'end')::time;
    if v_kind not in ('M','P','N','COP') then raise exception 'Turno non valido.' using errcode = '22023'; end if;
    if v_s is null or v_e is null or v_s = v_e then raise exception 'Indica l''ora di inizio e di fine.' using errcode = '22023'; end if;
    if exists (select 1 from public.shifts where staff_id = v_staff and date = v_date and kind = 'MU') then
      raise exception 'Una persona in malattia non può fare la copertura.' using errcode = '22023';
    end if;
    if v_kind = 'COP' then
      insert into public.shifts (staff_id, date, kind, start_time, end_time) values (v_staff, v_date, 'COP', v_s, v_e)
      on conflict (staff_id, date, kind) do update set start_time = excluded.start_time, end_time = excluded.end_time;
      insert into public.notifications (staff_id, kind, text, data)
      values (v_staff, 'copertura',
              'Ti è stata assegnata una copertura il ' || to_char(v_date, 'DD/MM') || ' dalle ' || to_char(v_s, 'HH24:MI') ||
              ' alle ' || to_char(v_e, 'HH24:MI') || '. Controlla il foglio.',
              jsonb_build_object('date', v_date, 'kind', 'COP'));
    else
      update public.shifts set start_time = v_s, end_time = v_e
       where staff_id = v_staff and date = v_date and kind = v_kind;
      if not found then raise exception 'Turno non trovato.' using errcode = '22023'; end if;
      insert into public.notifications (staff_id, kind, text, data)
      values (v_staff, 'copertura',
              'Il tuo turno ' || v_kind || ' del ' || to_char(v_date, 'DD/MM') || ' è stato modificato per una copertura: orario ' ||
              to_char(v_s, 'HH24:MI') || '–' || to_char(v_e, 'HH24:MI') || '. Controlla il foglio.',
              jsonb_build_object('date', v_date, 'kind', v_kind));
    end if;
  end loop;

  if p_report is not null and p_giorno is not null then
    select coalesce(jsonb_agg(case when e->>'date' = p_giorno::text then e || '{"done": true}'::jsonb else e end order by o), '[]'::jsonb)
      into v_days
      from public.sick_reports r, jsonb_array_elements(r.days) with ordinality as t(e, o)
     where r.id = p_report;
    if v_days = '[]'::jsonb then raise exception 'Segnalazione non trovata.' using errcode = '22023'; end if;
    select count(*) into v_aperti from jsonb_array_elements(v_days) e where coalesce((e->>'done')::boolean, false) = false;
    update public.sick_reports
       set days = v_days,
           status = case when v_aperti = 0 then 'closed' else 'open' end,
           closed_at = case when v_aperti = 0 then now() else null end
     where id = p_report;
  end if;
end;
$$;

create or replace function public.chiudi_malattia(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_coordinator() then raise exception 'Solo la coordinatrice.' using errcode = '42501'; end if;
  update public.sick_reports set status = 'closed', closed_at = now() where id = p_id and status = 'open';
end;
$$;

create or replace function public.segna_notifica_letta(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications set read_at = now()
   where id = p_id and read_at is null and staff_id = public.mia_persona();
$$;

revoke all on function public.anteprima_malattia(date, date), public.comunica_malattia(date, date),
  public.applica_copertura(bigint, date, jsonb), public.chiudi_malattia(bigint),
  public.segna_notifica_letta(bigint) from public;
grant execute on function public.anteprima_malattia(date, date), public.comunica_malattia(date, date),
  public.applica_copertura(bigint, date, jsonb), public.chiudi_malattia(bigint),
  public.segna_notifica_letta(bigint) to authenticated;

alter table public.notifications enable row level security;
alter table public.sick_reports  enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (staff_id in (select s.id from public.staff s where s.user_id = auth.uid()));
drop policy if exists sick_reports_select on public.sick_reports;
create policy sick_reports_select on public.sick_reports
  for select to authenticated
  using (public.is_coordinator() or staff_id in (select s.id from public.staff s where s.user_id = auth.uid()));
revoke all on public.notifications, public.sick_reports from anon, authenticated;
grant select on public.notifications, public.sick_reports to authenticated;

-- ---------------------------------------------------------------------
-- 16. Richieste di riposo o di turno
--     Le richieste di un mese sono SEMPRE aperte: dal 1 ottobre dell'anno prima fino alla mezzanotte (ora
--     italiana) del 20 del mese prima. Ogni operatore può inviarne al massimo 3 per mese (riposi e turni insieme).
--     - Regole che BLOCCANO la richiesta: giorno già occupato, turno già chiesto da un altro collega
--       (vince chi chiede prima), troppi riposi nello stesso giorno (2; d'estate 1), limite di 3 richieste.
--     - Regole che AVVISANO: mattina dopo un pomeriggio, più di due notti di fila, più di 4 giorni di
--       lavoro di fila, qualsiasi cosa il giorno dopo una notte, secondo riposo nello stesso giorno,
--       due riposi di fila in estate. L'operatore può inviare comunque: la richiesta arriva a Marie
--       segnata come "critica" (in giallo) e lei decide, scrivendo la motivazione.
--     - Dopo il 20 le richieste che Marie non ha esaminato valgono come ACCETTATE.
--     - Tutti gli operatori vedono tutte le richieste, e anche ferie, permessi, riposi e turni richiesti
--       del mese in preparazione (il resto del piano resta nascosto finché Marie non pubblica).
-- ---------------------------------------------------------------------
alter table public.months add column if not exists requests_open boolean not null default false;

create table if not exists public.requests (
  id         bigint generated always as identity primary key,
  staff_id   bigint not null references public.staff(id) on delete cascade,
  date       date   not null,
  kind       text   not null check (kind in ('RR','M','P','N')),
  status     text   not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default now(),         -- serve per la precedenza (chi chiede prima)
  decided_at timestamptz
);
alter table public.requests add column if not exists avvisi text[] not null default '{}';   -- regole non rispettate (richiesta critica)
alter table public.requests add column if not exists motivo text;                           -- motivazione di Marie
-- ferie e permessi: si chiedono da un giorno a un altro (last_date); riposi e turni sono di un solo giorno (last_date null)
alter table public.requests add column if not exists last_date date;
alter table public.requests drop constraint if exists requests_kind_check;
alter table public.requests add constraint requests_kind_check check (kind in ('RR','M','P','N','F','PERM'));
alter table public.requests drop constraint if exists requests_last_date_check;
alter table public.requests add constraint requests_last_date_check check (last_date is null or last_date >= date);
create index if not exists requests_date_idx on public.requests (date);
create unique index if not exists requests_attiva_uq on public.requests (staff_id, date) where status in ('pending','accepted');

-- oggi, all'ora italiana
create or replace function public.oggi() returns date language sql stable as $$ select (now() at time zone 'Europe/Rome')::date; $$;

-- ultimo giorno per inserire le richieste di un mese: il 20 del mese prima (fino a mezzanotte, ora italiana)
create or replace function public.richieste_scadenza(p_year int, p_month int) returns date
language sql immutable as $$ select (make_date(p_year, p_month, 1) - interval '1 month')::date + 19; $$;

-- ultimo giorno in cui Marie può rispondere: il 21 (fino a mezzanotte, ora italiana). Dopo, le richieste ancora aperte valgono come accettate.
create or replace function public.richieste_decisione(p_year int, p_month int) returns date
language sql immutable as $$ select public.richieste_scadenza(p_year, p_month) + 1; $$;

-- giorno che dentro ferie e permessi diventa il trattino: la domenica per tutti, il sabato per chi ha il contratto senza weekend
create or replace function public.giorno_libero(p_staff bigint, p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select extract(dow from p_date) = 0
      or (extract(dow from p_date) = 6 and coalesce((select senza_weekend from public.staff where id = p_staff), false));
$$;

-- primo giorno in cui si possono inserire le richieste di un mese: il 1 ottobre dell'anno prima
create or replace function public.richieste_inizio(p_year int, p_month int) returns date
language sql immutable as $$ select make_date(p_year - 1, 10, 1); $$;

-- le richieste di quel mese sono aperte adesso? (la data è sempre quella italiana: la scadenza scatta a mezzanotte di Roma)
create or replace function public.richieste_aperte(p_year int, p_month int) returns boolean
language sql stable as $$
  select public.oggi() between public.richieste_inizio(p_year, p_month) and public.richieste_scadenza(p_year, p_month);
$$;

-- Cosa fa la persona in quel giorno: il suo turno principale, oppure la richiesta in attesa
create or replace function public.tipo_giorno(p_staff bigint, p_date date, p_escludi bigint default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.kind from public.shifts s
      where s.staff_id = p_staff and s.date = p_date and s.kind in ('M','P','N','R','RR','F','FS','PERM','T1018') limit 1),
    (select r.kind from public.requests r
      where r.staff_id = p_staff and r.status = 'pending' and r.id is distinct from p_escludi
        and p_date between r.date and coalesce(r.last_date, r.date) limit 1));
$$;
revoke all on function public.tipo_giorno(bigint, date, bigint) from public;

-- Come si scrive una richiesta nelle notifiche: "di riposo del 15/12", "di ferie dal 10/12 al 17/12"...
create or replace function public.descr_richiesta(p_kind text, p_date date, p_last date default null) returns text
language sql immutable as $$
  select case p_kind when 'RR' then 'di riposo' when 'M' then 'della mattina' when 'P' then 'del pomeriggio' when 'N' then 'della notte'
                     when 'F' then 'di ferie' else 'di permesso' end
         || case when p_last is not null and p_last > p_date then ' dal ' || to_char(p_date, 'DD/MM') || ' al ' || to_char(p_last, 'DD/MM')
                 else ' del ' || to_char(p_date, 'DD/MM') end;
$$;

-- Ferie e permessi: BLOCCANO il giorno già occupato e i periodi oltre 45 giorni. Sabati e domeniche (al centro o ai margini) diventano il trattino
-- e i periodi troppo lunghi; AVVISANO se in quei giorni sono già assenti almeno 2 colleghi.
create or replace function public.controlla_ferie(p_staff bigint, p_da date, p_a date, p_escludi bigint default null)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare d date; n int; t text; a text[] := '{}'; giorni text := '';
begin
  if p_a < p_da then raise exception 'L''ultimo giorno è prima del primo.' using errcode = '22023'; end if;
  if p_a - p_da > 44 then raise exception 'Al massimo 45 giorni per volta.' using errcode = '22023'; end if;
  for d in select g::date from generate_series(p_da, p_a, interval '1 day') g loop
    t := public.tipo_giorno(p_staff, d, p_escludi);
    if t is not null and t <> 'R' then
      raise exception 'Il % hai già un turno, un riposo, un''assenza o una richiesta.', to_char(d, 'DD/MM') using errcode = '22023';
    end if;
    select count(*) into n from (
      select s.staff_id from public.shifts s join public.staff st on st.id = s.staff_id
       where s.date = d and s.kind in ('F','FS','PERM') and st.role = 'operator' and s.staff_id <> p_staff
      union
      select r.staff_id from public.requests r join public.staff st on st.id = r.staff_id
       where r.status = 'pending' and r.kind in ('F','PERM') and st.role = 'operator' and r.staff_id <> p_staff
         and r.id is distinct from p_escludi and d between r.date and coalesce(r.last_date, r.date)) x;
    if n >= 2 and not public.giorno_libero(p_staff, d) then giorni := giorni || case when giorni = '' then '' else ', ' end || to_char(d, 'DD/MM'); end if;
  end loop;
  if giorni <> '' then a := array_append(a, 'Sono già assenti almeno 2 colleghi (ferie o permessi) nei giorni: ' || giorni || '.'); end if;
  return a;
end;
$$;
revoke all on function public.controlla_ferie(bigint, date, date, bigint) from public;
revoke all on function public.giorno_libero(bigint, date) from public;

-- Applica una richiesta accettata al foglio (riposi e turni: una casella; ferie e permessi: tutti i giorni, le domeniche in mezzo sono il trattino)
create or replace function public.applica_richiesta(r public.requests)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare conflitti text;
begin
  if r.kind in ('F','PERM') then
    select string_agg(to_char(g.d::date, 'DD/MM'), ', ' order by g.d) into conflitti
      from generate_series(r.date, coalesce(r.last_date, r.date), interval '1 day') g(d)
     where exists (select 1 from public.shifts s where s.staff_id = r.staff_id and s.date = g.d::date
                      and s.kind in ('M','P','N','RR','F','FS','PERM','T1018','MU'));
    if conflitti is not null then raise exception 'In questi giorni c''è già un altro turno o un''assenza: %', conflitti using errcode = '22023'; end if;
    delete from public.shifts where staff_id = r.staff_id and kind = 'R' and date between r.date and coalesce(r.last_date, r.date);
    insert into public.shifts (staff_id, date, kind, requested)
    select r.staff_id, g.d::date, case when public.giorno_libero(r.staff_id, g.d::date) then 'FS' else r.kind end, false
      from generate_series(r.date, coalesce(r.last_date, r.date), interval '1 day') g(d);
  else
    insert into public.shifts (staff_id, date, kind, requested) values (r.staff_id, r.date, r.kind, r.kind in ('M','P','N'));
  end if;
end;
$$;
revoke all on function public.applica_richiesta(public.requests) from public;

-- Le regole del foglio applicate a UNA richiesta: se una regola BLOCCA solleva un errore,
-- altrimenti restituisce l'elenco delle regole non rispettate (vuoto = richiesta regolare)
drop function if exists public.controlla_regole_richiesta(bigint, date, text, bigint);
create or replace function public.controlla_regole_richiesta(p_staff bigint, p_date date, p_kind text, p_escludi bigint default null)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare prima text; dopo text; sx int := 0; dx int := 0; n int; a text[] := '{}';
        estate boolean := extract(month from p_date) in (6,7,8);
begin
  if public.tipo_giorno(p_staff, p_date, p_escludi) is not null then
    raise exception 'In quel giorno hai già un turno, un riposo o una richiesta.' using errcode = '22023';
  end if;
  prima := public.tipo_giorno(p_staff, p_date - 1, p_escludi);
  dopo  := public.tipo_giorno(p_staff, p_date + 1, p_escludi);

  if prima = 'N' and p_kind <> 'N' then
    a := array_append(a, 'Il giorno dopo una notte è riposo obbligatorio.');
  end if;
  if p_kind = 'N' then
    if dopo is not null and dopo not in ('N','R','RR') then
      a := array_append(a, 'Il giorno dopo una notte deve restare libero per il riposo.');
    end if;
    while public.tipo_giorno(p_staff, p_date - (sx + 1), p_escludi) = 'N' loop sx := sx + 1; end loop;
    while public.tipo_giorno(p_staff, p_date + (dx + 1), p_escludi) = 'N' loop dx := dx + 1; end loop;
    if sx + dx + 1 >= 3 then a := array_append(a, 'Più di due notti consecutive.'); end if;
  end if;
  if (p_kind = 'M' and prima = 'P') or (p_kind = 'P' and dopo = 'M') then
    a := array_append(a, 'Una mattina il giorno dopo un pomeriggio: restano meno di 11 ore di stacco.');
  end if;
  if p_kind in ('M','P','N') then
    sx := 0; dx := 0;
    while public.tipo_giorno(p_staff, p_date - (sx + 1), p_escludi) in ('M','P','N','T1018') loop sx := sx + 1; end loop;
    while public.tipo_giorno(p_staff, p_date + (dx + 1), p_escludi) in ('M','P','N','T1018') loop dx := dx + 1; end loop;
    if sx + dx + 1 > 4 then a := array_append(a, 'Più di 4 giorni di lavoro consecutivi.'); end if;
    if exists (select 1 from public.shifts s where s.date = p_date and s.kind = p_kind and s.staff_id <> p_staff)
       or exists (select 1 from public.requests r where r.date = p_date and r.kind = p_kind and r.status = 'pending'
                   and r.staff_id <> p_staff and r.id is distinct from p_escludi) then
      raise exception 'Quel turno è già stato chiesto o assegnato a un altro collega.' using errcode = '22023';
    end if;
  else
    select count(*) into n from (
      select s.staff_id from public.shifts s where s.date = p_date and s.kind in ('R','RR') and s.staff_id <> p_staff
      union
      select r.staff_id from public.requests r where r.date = p_date and r.kind = 'RR' and r.status = 'pending'
         and r.staff_id <> p_staff and r.id is distinct from p_escludi) x;
    if estate and n >= 1 then
      raise exception 'D''estate in un giorno può riposare una sola persona: quel giorno c''è già un riposo.' using errcode = '22023';
    end if;
    if n >= 2 then
      raise exception 'Quel giorno ci sono già due riposi.' using errcode = '22023';
    end if;
    if n = 1 then a := array_append(a, 'È il secondo riposo di quel giorno.'); end if;
    if estate and (prima in ('R','RR') or dopo in ('R','RR')) then
      a := array_append(a, 'D''estate non sono previsti due riposi di fila.');
    end if;
  end if;
  return a;
end;
$$;
revoke all on function public.controlla_regole_richiesta(bigint, date, text, bigint) from public;

create or replace function public.nome_mese(p_month int) returns text language sql immutable as $$
  select (array['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'])[p_month];
$$;

-- Mesi per cui le richieste sono aperte adesso (nessuno deve aprirle: valgono le date)
create or replace function public.mesi_richieste()
returns table (year int, month int, scadenza date)
language sql
stable
security definer
set search_path = public
as $$
  select extract(year from d)::int, extract(month from d)::int, public.richieste_scadenza(extract(year from d)::int, extract(month from d)::int)
    from generate_series(date_trunc('month', public.oggi())::date, (date_trunc('month', public.oggi()) + interval '26 months')::date, interval '1 month') g(d)
   where public.is_staff_member()
     and public.richieste_aperte(extract(year from d)::int, extract(month from d)::int)
   order by 1, 2;
$$;

-- L'operatore invia una richiesta. Se qualche regola avvisa e p_conferma è falso, l'errore inizia con
-- "[avviso]": l'app lo mostra e, se l'operatore vuole, richiama con p_conferma = true.
drop function if exists public.invia_richiesta(date, text);
drop function if exists public.invia_richiesta(date, text, boolean);
create or replace function public.invia_richiesta(p_date date, p_kind text, p_conferma boolean default false, p_fine date default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_staff bigint := public.mia_persona(); v_id bigint; v_n int; v_nome text; v_av text[]; v_ultimo date;
begin
  if v_staff is null then raise exception 'Accesso non valido.' using errcode = '42501'; end if;
  if p_date is null or p_kind not in ('RR','M','P','N','F','PERM') then raise exception 'Richiesta non valida.' using errcode = '22023'; end if;
  v_ultimo := case when p_kind in ('F','PERM') then coalesce(p_fine, p_date) else null end;
  perform pg_advisory_xact_lock(hashtext('richieste'));
  if not public.richieste_aperte(extract(year from p_date)::int, extract(month from p_date)::int)
     or (v_ultimo is not null and not public.richieste_aperte(extract(year from v_ultimo)::int, extract(month from v_ultimo)::int)) then
    raise exception 'Le richieste per questo mese non sono aperte: si possono fare dal 1 ottobre dell''anno prima fino al 20 del mese prima.' using errcode = '22023';
  end if;
  if p_kind in ('F','PERM') then
    v_av := public.controlla_ferie(v_staff, p_date, v_ultimo, null);          -- ferie e permessi non contano nelle 3 richieste al mese
  else
    select count(*) into v_n from public.requests r
     where r.staff_id = v_staff and r.status in ('pending','accepted') and r.kind in ('RR','M','P','N')
       and date_trunc('month', r.date) = date_trunc('month', p_date);
    if v_n >= 3 then raise exception 'Hai già fatto 3 richieste per questo mese.' using errcode = '22023'; end if;
    v_av := public.controlla_regole_richiesta(v_staff, p_date, p_kind, null);
  end if;
  if cardinality(v_av) > 0 and not p_conferma then
    raise exception '[avviso] %', array_to_string(v_av, E'\n') using errcode = '22023';
  end if;

  insert into public.requests (staff_id, date, kind, last_date, avvisi) values (v_staff, p_date, p_kind, v_ultimo, v_av) returning id into v_id;
  select name into v_nome from public.staff where id = v_staff;
  insert into public.notifications (staff_id, kind, text, data)
  select c.id, 'richiesta',
         v_nome || ' ha inviato una richiesta ' || public.descr_richiesta(p_kind, p_date, v_ultimo) || '.' ||
           case when cardinality(v_av) > 0 then ' Richiesta critica: ' || array_to_string(v_av, ' ') else '' end,
         jsonb_build_object('request', v_id)
    from public.staff c
   where c.role = 'coordinator' and c.active and c.id <> v_staff and (c.end_date is null or c.end_date >= current_date);
  return v_id;
end;
$$;

create or replace function public.annulla_richiesta(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.requests set status = 'cancelled', decided_at = now()
   where id = p_id and status = 'pending' and staff_id = public.mia_persona();
$$;

-- Marie accetta o rifiuta. La motivazione è obbligatoria se rifiuta o se la richiesta è critica.
drop function if exists public.rispondi_richiesta(bigint, boolean, boolean);
create or replace function public.rispondi_richiesta(p_id bigint, p_accetta boolean, p_motivo text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r public.requests; v_mot text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  if not public.is_coordinator() then raise exception 'Solo la coordinatrice.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('richieste'));
  select * into r from public.requests where id = p_id and status = 'pending';
  if not found then raise exception 'Richiesta non trovata o già decisa.' using errcode = '22023'; end if;
  if v_mot is null and (not p_accetta or cardinality(r.avvisi) > 0) then
    raise exception 'Scrivi la motivazione.' using errcode = '22023';
  end if;

  if p_accetta then perform public.applica_richiesta(r); end if;
  update public.requests set status = case when p_accetta then 'accepted' else 'rejected' end, decided_at = now(), motivo = v_mot where id = r.id;
  insert into public.notifications (staff_id, kind, text, data)
  values (r.staff_id, 'richiesta',
          'La tua richiesta ' || public.descr_richiesta(r.kind, r.date, r.last_date) || ' è stata ' ||
          case when p_accetta then 'accettata.' else 'rifiutata.' end || coalesce(' Motivo: ' || v_mot, ''),
          jsonb_build_object('request', r.id));
end;
$$;

-- Gli operatori inviano entro mezzanotte del 20, Marie risponde entro mezzanotte del 21. Passato il 21 le richieste
-- non esaminate valgono come ACCETTATE: se Marie non le ha controllate è una sua mancanza, non dell'operatore.
-- (Se bastasse inviare tutto alle 23:59 del 20 per vederle accettate, gli operatori avrebbero troppo potere.)
-- L'app la chiama a ogni apertura.
create or replace function public.elabora_scadenze()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r public.requests; n int := 0; v_err text;
begin
  if not public.is_staff_member() then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('richieste'));
  for r in select * from public.requests q
            where q.status = 'pending'
              and public.oggi() > public.richieste_decisione(extract(year from q.date)::int, extract(month from q.date)::int)
            order by q.created_at, q.id loop
    begin
      perform public.applica_richiesta(r);
      update public.requests set status = 'accepted', decided_at = now(),
             motivo = 'Accettata in automatico: la coordinatrice non ha risposto entro i termini.' where id = r.id;
      insert into public.notifications (staff_id, kind, text, data)
      values (r.staff_id, 'richiesta', 'La tua richiesta ' || public.descr_richiesta(r.kind, r.date, r.last_date) ||
              ' è stata accettata (la coordinatrice non ha risposto entro il 21).', jsonb_build_object('request', r.id));
    exception when others then
      get stacked diagnostics v_err = message_text;
      update public.requests set status = 'rejected', decided_at = now(), motivo = 'Non applicabile: ' || v_err where id = r.id;
      insert into public.notifications (staff_id, kind, text, data)
      values (r.staff_id, 'richiesta', 'La tua richiesta ' || public.descr_richiesta(r.kind, r.date, r.last_date) ||
              ' non è applicabile: ' || v_err, jsonb_build_object('request', r.id));
    end;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Le ferie (o i permessi) della coordinatrice: le segna lei stessa, senza richiesta né approvazione.
-- Valgono le stesse regole di blocco delle ferie degli operatori (giorno già occupato, periodo troppo lungo);
-- sabati e domeniche, anche a inizio e fine del periodo, diventano il trattino.
create or replace function public.mie_ferie(p_da date, p_a date, p_kind text default 'F')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_staff bigint := public.mia_persona(); r public.requests;
begin
  if not public.is_coordinator() or v_staff is null then raise exception 'Solo la coordinatrice.' using errcode = '42501'; end if;
  if p_da is null or p_a is null or p_kind not in ('F','PERM') then raise exception 'Richiesta non valida.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('richieste'));
  perform public.controlla_ferie(v_staff, p_da, p_a, null);        -- solleva l'errore se qualcosa blocca; gli avvisi non servono
  r.staff_id := v_staff; r.date := p_da; r.last_date := p_a; r.kind := p_kind;
  perform public.applica_richiesta(r);
end;
$$;

-- Scrive nel mese il piano proposto dal generatore (bozza). Tutto in una volta: o va tutto o non cambia niente.
-- Il periodo è il mese più il 1° del mese dopo (se quel mese non è pubblicato).
-- p_sostituisci = true: prima toglie M, P, N e R non richiesti del periodo (ferie, permessi, richieste accettate, malattie,
-- coperture e il resto restano); false: aggiunge soltanto, il generatore ha già lasciato fuori le caselle occupate.
create or replace function public.scrivi_piano(p_year int, p_month int, p_righe jsonb, p_sostituisci boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_da date := make_date(p_year, p_month, 1); v_a date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date; v_n int := 0;
begin
  if not public.is_coordinator() then raise exception 'Solo la coordinatrice.' using errcode = '42501'; end if;
  if exists (select 1 from public.months where year = p_year and month = p_month and status = 'published') then
    raise exception 'Il mese è già pubblicato: non si può generare di nuovo.' using errcode = '22023';
  end if;
  -- il foglio mostra anche il 1° del mese dopo: il generatore lo compila come anticipo, a meno che quel mese sia già pubblicato
  if not exists (select 1 from public.months where year = extract(year from v_a + 1)::int and month = extract(month from v_a + 1)::int and status = 'published') then
    v_a := v_a + 1;
  end if;
  if p_sostituisci then
    delete from public.shifts where date between v_da and v_a and kind in ('M','P','N','R') and not requested
      and not exists (select 1 from public.shifts mu where mu.staff_id = shifts.staff_id and mu.date = shifts.date and mu.kind = 'MU');
  end if;
  insert into public.shifts (staff_id, date, kind, requested)
  select (r->>'staff_id')::bigint, (r->>'date')::date, r->>'kind', false
    from jsonb_array_elements(p_righe) r
   where (r->>'date')::date between v_da and v_a and r->>'kind' in ('M','P','N','R')
     and exists (select 1 from public.staff s where s.id = (r->>'staff_id')::bigint)
  on conflict (staff_id, date, kind) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- (niente più apertura manuale da parte di Marie)
drop function if exists public.imposta_richieste(int, int, boolean);

revoke all on function public.mesi_richieste(), public.invia_richiesta(date, text, boolean, date), public.annulla_richiesta(bigint),
  public.rispondi_richiesta(bigint, boolean, text), public.elabora_scadenze(), public.mie_ferie(date, date, text), public.scrivi_piano(int, int, jsonb, boolean) from public;
grant execute on function public.mesi_richieste(), public.invia_richiesta(date, text, boolean, date), public.annulla_richiesta(bigint),
  public.rispondi_richiesta(bigint, boolean, text), public.elabora_scadenze(), public.mie_ferie(date, date, text), public.scrivi_piano(int, int, jsonb, boolean) to authenticated;

-- Tutti i membri del personale vedono tutte le richieste
alter table public.requests enable row level security;
drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests
  for select to authenticated
  using (public.is_staff_member());
revoke all on public.requests from anon, authenticated;
grant select on public.requests to authenticated;

-- Nel mese in preparazione gli operatori vedono solo ciò che è stato chiesto o programmato da loro:
-- ferie, domeniche in ferie, permessi, riposi richiesti e turni richiesti. Il resto del piano resta nascosto
-- finché Marie non pubblica.
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated
  using (public.is_coordinator()
         or (public.is_staff_member()
             and (public.is_published(date) or kind in ('RR','F','FS','PERM') or requested)));
