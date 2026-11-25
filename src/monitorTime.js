const formatters = new Map();

export function monitorTime(value, zone) {
  const key = zone || '';
  if (!formatters.has(key)) {
    const options = { hour12: false, dateStyle: 'short', timeStyle: 'medium' };
    try {
      formatters.set(key, new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: key || undefined }));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return monitorTime(value, 'UTC');
    }
  }
  const formatter = formatters.get(key);
  const iso = String(value || '').trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + 'Z');
  return { text: Number.isNaN(date.valueOf()) ? '—' : formatter.format(date),
    zone: key || formatter.resolvedOptions().timeZone };
}
