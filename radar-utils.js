export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function formatScanAge(timestamp, now = new Date()) {
  const elapsed = Math.max(0, +now - Date.parse(timestamp));
  if (!Number.isFinite(elapsed)) return 'unknown';
  const hours = Math.floor(elapsed / 3600000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function nextMilestone(opportunity, now = new Date()) {
  return opportunity.milestones.filter(m => Date.parse(m.datetime) > +now)
    .sort((a,b) => Date.parse(a.datetime) - Date.parse(b.datetime))[0] || null;
}

export function readStored(storage, key, fallback, valid) {
  try {
    const value = JSON.parse(storage.getItem(key));
    return valid(value) ? value : fallback;
  } catch { return fallback; }
}
