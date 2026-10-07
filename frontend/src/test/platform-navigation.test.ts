import { describe, expect, it } from 'vitest';
import { canManageLibrary, platformNavigation, platformRole, platformSection, managementPageAllowed, platformLoginReturn } from '@/lib/platform-navigation';
describe('统一导航遵循实际身份',()=>{
 const nav=(roles:string[])=>platformNavigation({roles,portal:roles.includes('teacher')?'teacher':'student'}).map(item=>item.id);
 it('学生只有总览、课程、题库和自己的提交入口',()=>{expect(nav(['student'])).toEqual(['home','courses','library','judging']);expect(canManageLibrary({roles:['student'],portal:'student'})).toBe(false);});
 it('助教不因教学门户而获得教师账号管理与出题入口',()=>{expect(nav(['ta','student'])).toEqual(['home','courses','library','judging']);expect(canManageLibrary({roles:['ta'],portal:'teacher'})).toBe(false);});
 it('教师可以维护名单与题单，站点设置仅超级管理员可见',()=>{expect(nav(['teacher'])).toEqual(['home','courses','library','users','actions']);expect(nav(['teacher','student'])).not.toContain('judging');expect(nav(['admin','teacher'])).toEqual(['home','courses','library','users','actions','announcement']);});
 it('身份未确认、过期或未知角色时不显示受保护入口',()=>{expect(platformNavigation(null)).toEqual([]);expect(nav([])).toEqual([]);expect(nav(['unknown'])).toEqual([]);});
 it('作业与成绩沿用课程导航高亮，所有题库视图沿用题库高亮',()=>{expect(platformSection('/assignments/3/problems/1003')).toBe('courses');expect(platformSection('/programming/grades/3')).toBe('courses');expect(platformSection('/library/problems/p01')).toBe('library');expect(platformSection('/management/admin2/users')).toBe('users');});
 it('直接输入管理页面地址也按身份阻止访问',()=>{expect(managementPageAllowed(0,'/admin2/users')).toBe(false);expect(managementPageAllowed(1,'/admin2/announcement')).toBe(false);expect(managementPageAllowed(2,'/admin2/announcement')).toBe(true);expect(managementPageAllowed(undefined,'/admin2/actions')).toBe(false);});
 it('学生不能直接进入教师的学生详情页',()=>{expect(managementPageAllowed(0,'/courses/12/students/20260001')).toBe(false);expect(managementPageAllowed(1,'/courses/12/students/20260001')).toBe(true);expect(managementPageAllowed(2,'/courses/12/students/20260001')).toBe(true);expect(platformSection('/management/courses/12/students/20260001')).toBe('courses');});
 it('统一登录能返回选班后的题库和管理课程，拒绝外站回跳',()=>{expect(platformLoginReturn('/library?view=public&oid=3')).toBe('/library?view=public&oid=3');expect(platformLoginReturn('/courses/12')).toBe('/management/courses/12');for(const url of ['//evil.test','/\\evil.test','https://evil.test','/api/session',undefined])expect(platformLoginReturn(url)).toBe('/management/home');});
 it('身份标签支持留学生英文界面',()=>{expect(platformRole({roles:['student'],portal:'student'},'en')).toBe('Student');expect(platformRole({roles:['ta','student'],portal:'teacher'})).toBe('助教');});
});
