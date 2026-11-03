const prefix = 'adx:read-cache:v1:';
const maxEntries = 8;

function keyFor(user) {
  if (!user?.id) return '';
  return prefix + [user.id, user.role, user.channelId || 0].join(':');
}

export function readCached(user, path) {
  const key = keyFor(user);
  if (!key) return null;
  try {
    const entries = JSON.parse(sessionStorage.getItem(key) || '{}');
    const entry = entries[path];
    return entry?.data?.ok === true ? entry : null;
  } catch { return null; }
}

export function rememberRead(user, path, data) {
  const key = keyFor(user);
  if (!key || data?.ok !== true) return;
  try {
    const entries = JSON.parse(sessionStorage.getItem(key) || '{}');
    entries[path] = { savedAt: Date.now(), data };
    const paths = Object.keys(entries).sort((a, b) => entries[a].savedAt - entries[b].savedAt);
    for (const old of paths.slice(0, Math.max(0, paths.length - maxEntries))) delete entries[old];
    sessionStorage.setItem(key, JSON.stringify(entries));
  } catch { /* A full or disabled storage must not interrupt the report. */ }
}

export function clearCachedUser(user) {
  const key = keyFor(user);
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
