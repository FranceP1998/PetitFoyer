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

// Le festività si decidono per "stagione", come l'anno scolastico: da Natale all'estate dopo (dal 24 dicembre al 15 agosto).
// La stagione 2026 va dal 16 agosto 2026 al 15 agosto 2027 (così contiene anche eventuali date aggiunte in autunno).
export const stagioneDi = (data) => (data.slice(5) >= '08-16' ? +data.slice(0, 4) : +data.slice(0, 4) - 1);
export const intervalloStagione = (st) => ({ da: `${st}-08-16`, a: `${st + 1}-08-15` });
export const nomeStagione = (st) => `${st}/${String(st + 1).slice(2)}`;

export function festivitaPredefinite(st) {
  const p = pasqua(st + 1);
  return [
    { date: `${st}-12-24`, label: 'Vigilia di Natale' },
    { date: `${st}-12-25`, label: 'Natale' },
    { date: `${st}-12-31`, label: "Ultimo dell'anno" },
    { date: `${st + 1}-01-01`, label: 'Capodanno' },
    { date: `${st + 1}-01-06`, label: 'Epifania' },
    { date: p, label: 'Pasqua' },
    { date: piu(p, 1), label: 'Pasquetta' },
    { date: `${st + 1}-04-25`, label: 'Festa della Liberazione' },
    { date: `${st + 1}-05-01`, label: 'Festa dei lavoratori' },
    { date: `${st + 1}-06-02`, label: 'Festa della Repubblica' },
    { date: `${st + 1}-08-15`, label: 'Ferragosto' },
  ];
}
