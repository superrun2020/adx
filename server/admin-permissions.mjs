export const adminSidebarViews = ['dashboard', 'gam', 'links', 'ad-units', 'reports', 'regression', 'channels', 'settlement', 'report-keys', 'api'];

export function parseSidebarPermissions(value) {
  if (!Array.isArray(value) || !value.length || value.length > adminSidebarViews.length ||
      value.some(view => typeof view !== 'string' || !adminSidebarViews.includes(view)) ||
      new Set(value).size !== value.length) throw new Error('invalid_sidebar_permissions');
  return value;
}

export function sidebarPermissionsFor(user) {
  if (user.role !== 'admin') return ['dashboard', 'reports', 'api'];
  if (user.is_super_admin || user.isSuperAdmin || user.sidebar_permissions == null) return [...adminSidebarViews];
  try { return parseSidebarPermissions(JSON.parse(user.sidebar_permissions)); }
  catch { return []; }
}

export function canView(user, view) {
  if (view === 'admins') return user.role === 'admin' && Boolean(user.is_super_admin || user.isSuperAdmin);
  return sidebarPermissionsFor(user).includes(view);
}

export function allowedAdminRequest(user, path, method) {
  if (user.role !== 'admin' || user.is_super_admin || user.isSuperAdmin) return true;
  let views;
  if (path === '/api/auth/me' || path === '/api/auth/logout') return true;
  if (path === '/api/dashboard' || path === '/api/dashboard/highlights') views = ['dashboard'];
  else if (['/api/reports','/api/reports/export','/api/admin/reports/accounts'].includes(path)) views = ['reports'];
  else if (path.startsWith('/api/admin/users') || path === '/api/admin/audit') return false;
  else if (path.startsWith('/api/admin/report-api-keys')) views = ['report-keys'];
  else if (path.startsWith('/api/admin/regression/')) views = ['regression'];
  else if (path === '/api/admin/link-metadata') views = ['links'];
  else if (path === '/api/admin/gam-accounts' && method === 'GET') views = ['gam','links','ad-units','regression'];
  else if (path.startsWith('/api/admin/gam-accounts/') && method === 'GET' && (path.endsWith('/sites') || path.endsWith('/site-domains'))) views = ['gam','links','ad-units'];
  else if (path.startsWith('/api/admin/gam-accounts/') && method === 'GET' && path.endsWith('/ad-units')) views = ['gam','ad-units'];
  else if (path.startsWith('/api/admin/gam-accounts') || path.startsWith('/api/admin/gam-sync/')) views = ['gam'];
  else if (path.startsWith('/api/admin/gam-ad-units') || path.startsWith('/api/admin/ad-units')) views = ['ad-units'];
  else if (path === '/api/admin/channels' && method === 'GET') views = ['channels','settlement','gam','reports'];
  else if (path.startsWith('/api/admin/channels')) views = ['channels'];
  else if (path === '/api/admin/upstream-accounts' && method === 'GET') views = ['settlement','gam','reports'];
  else if (['/api/admin/upstream-accounts','/api/admin/ad-unit-domains','/api/admin/share-rules','/api/admin/domain-share-rules'].some(prefix => path.startsWith(prefix))) views = ['settlement'];
  else if (path.startsWith('/api/admin/imports')) views = ['reports'];
  else return false;
  return views.some(view => canView(user, view));
}
