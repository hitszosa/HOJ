import { draftStorageKey, matchRoute, redirectPath, readDraft, routePortal, writeDraft } from "@/lib/routes";
import { describe, expect, it } from "vitest";

describe('统一页面与旧链接迁移',()=>{
 it('题库、评测和作业只有一个身份无关的地址',()=>{
  expect(matchRoute('/library')).toEqual({name:'library'});
  expect(matchRoute('/judging')).toEqual({name:'status'});
  expect(matchRoute('/library/problems/p01')).toEqual({name:'problem',pid:'p01'});
  expect(matchRoute('/assignments/3')).toEqual({name:'batch',bid:'3'});
  expect(matchRoute('/assignments/3/problems/1003')).toEqual({name:'workspace',bid:'3',pid:'1003'});
  for(const path of ['/library','/judging','/assignments/3','/assignments/3/problems/1003'])expect(routePortal(matchRoute(path))).toBeNull();
 });
 it('任课教师功能仍有角色检查',()=>{
  expect(matchRoute('/programming/offerings/3')).toEqual({name:'studio',oid:'3'});
  expect(matchRoute('/programming/drafts/a')).toEqual({name:'draft',did:'a'});
  expect(matchRoute('/programming/grades/3')).toEqual({name:'insights',oid:'3'});
  for(const path of ['/programming/offerings/3','/programming/drafts/a','/programming/grades/3'])expect(routePortal(matchRoute(path))).toBe('teacher');
 });
 it('旧模块地址跳回统一题库和评测',()=>{
  for(const path of ['/teacher/categories','/student/categories','/student/problems','/category.php'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/library?view=public'});
  for(const path of ['/teacher/library','/teacher/problems','/teacher/problem-sets'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/library?view=mine'});
  for(const path of ['/teacher/status','/student/status'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/judging'});
 });
 it('旧作业、题目和出题地址跳到统一功能',()=>{
  for(const path of ['/teacher/batches/3','/student/batches/3','/batches/3'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/assignments/3'});
  for(const path of ['/teacher/batches/3/problems/1003','/student/batches/3/problems/1003','/batches/3/problems/1003'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/assignments/3/problems/1003'});
  expect(matchRoute('/student/categories/problems/p01')).toEqual({name:'redirect',to:'/library/problems/p01'});
  expect(matchRoute('/teacher/offerings/3')).toEqual({name:'redirect',to:'/programming/offerings/3'});
  expect(matchRoute('/teacher/drafts/a')).toEqual({name:'redirect',to:'/programming/drafts/a'});
  expect(matchRoute('/teacher/insights/3')).toEqual({name:'redirect',to:'/programming/grades/3'});
 });
 it('课程入口依然只用教学管理，旧课程按授权映射',()=>{
  for(const path of ['/teacher','/student','/student/history','/history'])expect(matchRoute(path)).toEqual({name:'redirect',to:'/management/courses'});
  for(const path of ['/courses/3','/teacher/courses/3','/student/courses/3','/teacher/classes/3'])expect(matchRoute(path)).toEqual({name:'managed-course',oid:'3'});
  expect(matchRoute('/faq')).toEqual({name:'redirect',to:'/management/docs'});
 });
 it('跳转保留班级预选、筛选和重复参数',()=>{
  expect(redirectPath('/library?view=public',{oid:'3',tag:['a','b']})).toBe('/library?view=public&oid=3&tag=a&tag=b');
  expect(redirectPath('/judging',{problem_id:'1003'})).toBe('/judging?problem_id=1003');
 });
 it('未知路径、排行榜与畸形路径保持404',()=>{
  for(const path of ['/student/ranklist','/teacher/ranklist','/ranklist','/nope','/assignments/3/edit','/programming/drafts','/api/leak','/student/nope','/courses/3/edit'])expect(matchRoute(path),path).toEqual({name:'not-found'});
 });
});
describe('草稿身份隔离',()=>{
 it('不同用户和匿名草稿不串号',()=>{
  expect(draftStorageKey('a','3','1003')).not.toBe(draftStorageKey('b','3','1003'));
  expect(draftStorageKey('','3','1003')).toBe('code:anon:3:1003');
  localStorage.clear();localStorage.setItem('code:3:1003','legacy');
  expect(readDraft('a','3','1003')).toBe('');writeDraft('a','3','1003','student-code');
  expect(readDraft('a','3','1003')).toBe('student-code');expect(readDraft('b','3','1003')).toBe('');
 });
});
