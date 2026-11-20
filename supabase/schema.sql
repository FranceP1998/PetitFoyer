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
grant select (id, name, role, sort_order, active, fixed_pattern, user_id, start_date, end_date) on public.staff to authenticated;

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
create or replace function public.elenco_personale()
returns table (
  id bigint, name text, email text, role text, sort_order int, active boolean,
  fixed_pattern boolean, contract_hours numeric, start_date date, end_date date, ha_accesso boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.email, s.role, s.sort_order, s.active, s.fixed_pattern,
         s.contract_hours, s.start_date, s.end_date, (s.user_id is not null)
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
grant select (id, name, role, sort_order, active, fixed_pattern, user_id, start_date, end_date) on public.staff to authenticated;
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

-- La coordinatrice conferma l'orario di copertura di un collega: SOLO ora il collega riceve la notifica
create or replace function public.conferma_copertura(p_staff bigint, p_date date, p_kind text, p_start time, p_end time)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_coordinator() then
    raise exception 'Solo la coordinatrice.' using errcode = '42501';
  end if;
  if p_kind not in ('M','P','N') then raise exception 'Turno non valido.' using errcode = '22023'; end if;
  update public.shifts set start_time = p_start, end_time = p_end
   where staff_id = p_staff and date = p_date and kind = p_kind;
  if not found then raise exception 'Turno non trovato.' using errcode = '22023'; end if;
  insert into public.notifications (staff_id, kind, text, data)
  values (p_staff, 'copertura',
          'Il tuo turno ' || p_kind || ' del ' || to_char(p_date, 'DD/MM') || ' è stato modificato per una copertura: orario ' ||
          to_char(p_start, 'HH24:MI') || '–' || to_char(p_end, 'HH24:MI') || '. Controlla il foglio.',
          jsonb_build_object('date', p_date, 'kind', p_kind));
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
  public.conferma_copertura(bigint, date, text, time, time), public.chiudi_malattia(bigint),
  public.segna_notifica_letta(bigint) from public;
grant execute on function public.anteprima_malattia(date, date), public.comunica_malattia(date, date),
  public.conferma_copertura(bigint, date, text, time, time), public.chiudi_malattia(bigint),
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
