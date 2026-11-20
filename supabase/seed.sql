-- =====================================================================
-- Persone del Petit Foyer. Eseguire DOPO schema.sql.
-- Poi sostituisci le email con quelle vere (vedi README, passo 4).
-- =====================================================================
insert into public.staff (name, role, sort_order, fixed_pattern, email) values
  ('Anna',     'operator',    10, false, 'anna@example.com'),
  ('Frederic', 'operator',    20, false, 'frederic@example.com'),
  ('Domenico', 'operator',    30, false, 'domenico@example.com'),
  ('Andrea',   'operator',    40, true,  'andrea@example.com'),
  ('Stella',   'operator',    50, false, 'stella@example.com'),
  ('Aurora',   'operator',    60, false, 'aurora@example.com'),
  ('Marie',    'coordinator', 70, false, 'marie@example.com')
on conflict (email) do nothing;
