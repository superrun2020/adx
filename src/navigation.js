export const viewPaths = Object.freeze({
  dashboard: '/',
  reports: '/reports',
  gam: '/gam-accounts',
  links: '/links',
  channels: '/channels',
  settlement: '/settlement',
  'ad-units': '/ad-units',
  admins: '/admins',
  'report-keys': '/report-keys',
  api: '/api-docs'
});

const pathViews = new Map(Object.entries(viewPaths).map(([view, path]) => [path, view]));
const adminOnlyViews = new Set(['gam', 'links', 'channels', 'settlement', 'ad-units', 'admins', 'report-keys']);

export function viewForPath(pathname, fallback = 'dashboard', role = 'admin') {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  const view = pathViews.get(path) || fallback;
  return role !== 'admin' && adminOnlyViews.has(view) ? fallback : view;
}
