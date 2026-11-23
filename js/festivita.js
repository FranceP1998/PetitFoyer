// Elenco predefinito delle festività da assegnare nella riunione. La coordinatrice può aggiungerne e toglierne.

// Pasqua (calendario gregoriano, algoritmo di Meeus/Jones/Butcher)
export function pasqua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`;
}
const piu = (data, n) => { const x = new Date(`${data}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function festivitaPredefinite(y) {
  const p = pasqua(y);
  return [
    { date: `${y}-01-01`, label: 'Capodanno' },
    { date: `${y}-01-06`, label: 'Epifania' },
    { date: p, label: 'Pasqua' },
    { date: piu(p, 1), label: 'Pasquetta' },
    { date: `${y}-04-25`, label: 'Festa della Liberazione' },
    { date: `${y}-05-01`, label: 'Festa dei lavoratori' },
    { date: `${y}-06-02`, label: 'Festa della Repubblica' },
    { date: `${y}-08-15`, label: 'Ferragosto' },
    { date: `${y}-12-24`, label: 'Vigilia di Natale' },
    { date: `${y}-12-25`, label: 'Natale' },
    { date: `${y}-12-31`, label: "Ultimo dell'anno" },
  ];
}
