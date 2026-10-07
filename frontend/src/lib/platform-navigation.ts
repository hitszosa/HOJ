/** Both renderers use this policy; page visibility never replaces API authorization. */
export type PlatformIdentity = { roles: readonly string[]; portal: string };
export type PlatformSection = 'home' | 'courses' | 'library' | 'judging' | 'users' | 'actions' | 'announcement';
const ITEMS = [
  { id:'home', href:'/management/home', zh:'总览', en:'Overview', roles:[] },
  { id:'courses', href:'/management/courses', zh:'课程', en:'Courses', roles:[] },
  { id:'library', href:'/library', zh:'题库', en:'Problem library', roles:[] },
  { id:'judging', href:'/judging', zh:'我的提交', en:'My submissions', roles:['student','ta'] },
  { id:'users', href:'/management/admin2/users', zh:'用户与名单', en:'Users & rosters', roles:['teacher','admin'] },
  { id:'actions', href:'/management/admin2/actions', zh:'操作记录', en:'Activity', roles:['teacher','admin'] },
  { id:'announcement', href:'/management/admin2/announcement', zh:'站点设置', en:'Site settings', roles:['admin'] },
] as const;
export function platformNavigation(identity: PlatformIdentity | null | undefined) {
  if (!identity || !identity.roles.some(role => ['student','ta','teacher','admin'].includes(role))) return [];
  return ITEMS.filter(item => (item.id!=='judging'||!canManageLibrary(identity))&&(!item.roles.length || item.roles.some(role => identity.roles.includes(role))));
}
export function canManageLibrary(identity: PlatformIdentity | null | undefined) {
  return !!identity?.roles.some(role => role === 'teacher' || role === 'admin');
}
export function platformRole(identity: PlatformIdentity | null | undefined, locale = 'zh') {
  const role = ['admin','teacher','ta','student'].find(role => identity?.roles.includes(role));
  const labels:Record<string,[string,string]> = {admin:['超级管理员','Administrator'],teacher:['教师','Teacher'],ta:['助教','Teaching assistant'],student:['学生','Student']};
  return role ? labels[role][locale === 'en' ? 1 : 0] : '';
}
export function platformSection(path: string): PlatformSection | null {
  if (path === '/management/home') return 'home';
  if (path.startsWith('/management/admin2/users')) return 'users';
  if (path.startsWith('/management/admin2/actions')) return 'actions';
  if (path.startsWith('/management/admin2/announcement')) return 'announcement';
  if (path.startsWith('/library') || path === '/teacher/library' || path.endsWith('/categories')) return 'library';
  if (path === '/judging' || path.endsWith('/status')) return 'judging';
  if (path.startsWith('/management/courses') || path.startsWith('/assignments/') || path.startsWith('/programming/')) return 'courses';
  return null;
}
/** Management profile roles come from the same authenticated HOJ identity. */
export function managementPageAllowed(role: number | undefined, path: string) {
  if (/^\/courses\/[^/]+\/students\//.test(path)) return role === 1 || role === 2;
  if (path.startsWith('/admin2/announcement')) return role === 2;
  if (path.startsWith('/admin2/')) return role === 1 || role === 2;
  return true;
}
/** Management bookmarks use base-relative paths; shared feature bookmarks already use root paths. */
export function platformLoginReturn(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/management/home';
  const url = new URL(next, 'https://platform.local');
  if (url.origin !== 'https://platform.local') return '/management/home';
  if (['/management/','/library','/judging','/assignments/','/programming/','/teacher/','/student/'].some(prefix => url.pathname.startsWith(prefix))) return url.pathname+url.search+url.hash;
  if (['/home','/courses','/change_info','/preferences','/docs','/admin2/'].some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/'))) return '/management'+url.pathname+url.search+url.hash;
  return '/management/home';
}
