export const viewPaths = Object.freeze({
  dashboard: '/',
  reports: '/reports',
  gam: '/gam-accounts',
  links: '/links',
  regression: '/regression',
  'bot-report': '/bot-report',
  channels: '/channels',
  settlement: '/settlement',
  'ad-units': '/ad-units',
  admins: '/admins',
  'report-keys': '/report-keys',
  api: '/api-docs'
});

const pathViews = new Map(Object.entries(viewPaths).map(([view, path]) => [path, view]));
const adminOnlyViews = new Set(['gam', 'links', 'regression', 'bot-report', 'channels', 'settlement', 'ad-units', 'admins', 'report-keys']);

export const adminPermissionOptions = Object.freeze([
  { value: 'dashboard', label: '经营总览' }, { value: 'gam', label: '账号管理' },
  { value: 'links', label: '链接管理' }, { value: 'ad-units', label: '广告单元创建' },
  { value: 'reports', label: '数据报告' }, { value: 'regression', label: '数据回退监测' },
  { value: 'bot-report', label: '机器人汇报' },
  { value: 'channels', label: '渠道管理' }, { value: 'settlement', label: '结算配置' },
  { value: 'report-keys', label: '账户日报 API Key' }, { value: 'api', label: '渠道 API' }
]);

export function canVisit(userOrRole, view) {
  const user = typeof userOrRole === 'string' ? { role: userOrRole } : userOrRole || {};
  if (user.role !== 'admin') return !adminOnlyViews.has(view);
  if (user.isSuperAdmin || userOrRole === 'admin') return true;
  if (view === 'admins') return false;
  return !Array.isArray(user.sidebarPermissions) || user.sidebarPermissions.includes(view);
}

export function viewForPath(pathname, fallback = 'dashboard', userOrRole = 'admin') {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  const view = pathViews.get(path) || fallback;
  if (canVisit(userOrRole, view)) return view;
  if (canVisit(userOrRole, fallback)) return fallback;
  return Object.keys(viewPaths).find(candidate => canVisit(userOrRole, candidate)) || 'dashboard';
}

export function shouldNavigateInPlace(event) {
  return (!event || event.button == null || event.button === 0) &&
    !event?.ctrlKey && !event?.metaKey && !event?.shiftKey && !event?.altKey;
}
