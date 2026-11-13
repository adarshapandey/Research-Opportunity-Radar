// Normalize only explicit dates, times and zones found together in source evidence.
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = n => String(n).padStart(2, '0');
export const normalizeText = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function parseDeadline(evidence) {
  const text = normalizeText(evidence);
  const dates = new Set();
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})(?=T|\b)/g)) dates.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+['’]?(20\d{2}|\d{2})\b/gi)) {
    dates.add(`${m[3].length === 2 ? '20' : ''}${m[3]}-${pad(months.indexOf(m[1].slice(0,3).toLowerCase()) + 1)}-${pad(m[2])}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?[,]?\s+(20\d{2})\b/gi)) {
    dates.add(`${m[3]}-${pad(months.indexOf(m[2].slice(0,3).toLowerCase()) + 1)}-${pad(m[1])}`);
  }
  const times = new Set();
  for (const m of text.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?=\b|Z)/gi)) {
    // Do not treat a numeric timezone offset as another time.
    if (/[+-]$/.test(text.slice(0,m.index))) continue;
    let h = Number(m[1]);
    if (m[4]) { if (h < 1 || h > 12) return null; h = h % 12 + (/pm/i.test(m[4]) ? 12 : 0); }
    if (h > 23 || Number(m[2]) > 59 || Number(m[3] || 0) > 59) return null;
    times.add(`${pad(h)}:${m[2]}:${m[3] || '00'}`);
  }
  if (dates.size !== 1 || times.size !== 1) return null;
  const date = [...dates][0], time = [...times][0];
  const wall = new Date(`${date}T${time}Z`);
  if (Number.isNaN(+wall) || wall.toISOString().slice(0,10) !== date) return null;
  const zones = new Set();
  if (/\b(?:AoE|Anywhere on Earth)\b/i.test(text)) zones.add('-12:00');
  for (const m of text.matchAll(/\b(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?/gi)) {
    if (+m[2] > 14 || +(m[3] || 0) > 59 || (+m[2] === 14 && +(m[3] || 0))) return null;
    zones.add(`${m[1]}${pad(m[2])}:${m[3] || '00'}`);
  }
  if (/\b(?:UTC|GMT)\b(?!\s*[+-])/i.test(text)) zones.add('+00:00');
  const iso = text.match(/T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})\b/);
  if (iso) zones.add(iso[1] === 'Z' ? '+00:00' : iso[1]);
  if (zones.size !== 1) return null; // Abbreviations and unstated zones require review.
  const offset = [...zones][0];
  const datetime = `${date}T${time}${offset}`;
  if (Number.isNaN(Date.parse(datetime))) return null;
  return { datetime, timezone: `UTC${offset}`, timezone_label: offset === '-12:00' ? 'Anywhere on Earth' : `UTC${offset}` };
}
