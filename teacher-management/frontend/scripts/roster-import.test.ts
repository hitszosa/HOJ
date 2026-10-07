import assert from 'node:assert/strict';
import test from 'node:test';
import { utils, write, read } from 'xlsx';
import { readFileSync } from 'node:fs';
import { parseRosterWorkbook, parseRosterFile } from '../src/utils/roster-import.ts';

function book(rows: unknown[][], name = '任意名称') {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), name);
  return workbook;
}
test('two-column roster defaults students and preserves leading zeros', () => {
  const result = parseRosterWorkbook(book([['学号', '姓名'], ['001234', '张三']]));
  assert.deepEqual(result.users, [{ username: '001234', real_name: '张三', role: 0, password_expired: true }]);
});
test('legacy three-column template accepts teacher and student roles', () => {
  assert.deepEqual(parseRosterWorkbook(book([['用户名', '姓名', '角色'], ['teacher1', '王老师', '教师'], ['student1', '李四', '学生']])).users.map((u) => u.role), [1, 0]);
});
test('headers and cells accept surrounding spaces and BOM', () => {
  assert.equal(parseRosterWorkbook(book([['\uFEFF学号 ', ' 姓名'], [' 001 ', ' 张三 ']])).users[0].username, '001');
});
test('formatted numeric cells preserve displayed leading zeros', () => {
  const workbook = book([['学号', '姓名'], [123, '张三']]);
  workbook.Sheets['任意名称'].A2.z = '000000';
  assert.equal(parseRosterWorkbook(workbook).users[0].username, '000123');
});
test('blank rows are ignored and identical repeated rows are merged', () => {
  const result = parseRosterWorkbook(book([['学号', '姓名'], [], ['001', '张三'], ['001', '张三']]));
  assert.equal(result.users.length, 1);
  assert.equal(result.skippedDuplicates, 1);
});
test('conflicting duplicate IDs produce a row-level error', () => {
  assert.throws(() => parseRosterWorkbook(book([['学号', '姓名'], ['001', '张三'], ['001', '李四']])), /第 3 行.*第 2 行.*冲突/);
});
test('missing name reports the correct Excel row before any write', () => {
  assert.throws(() => parseRosterWorkbook(book([['学号', '姓名'], ['001', '']])), /第 2 行.*姓名不能为空/);
});
test('invalid role and malformed username are rejected', () => {
  assert.throws(() => parseRosterWorkbook(book([['用户名', '姓名', '角色'], ['001', '张三', '管理员']])), /角色只能/);
  assert.throws(() => parseRosterWorkbook(book([['学号', '姓名'], ['bad+id', '张三']])), /第 2 行.*用户名/);
});
test('wrong headers and an empty roster have clear format errors', () => {
  assert.throws(() => parseRosterWorkbook(book([['编号', '名字'], ['001', '张三']])), /表头不正确/);
  assert.throws(() => parseRosterWorkbook(book([['学号', '姓名']])), /表格内容为空/);
});
test('multi-sheet workbook finds a uniquely matching roster without a fixed name', () => {
  const workbook = book([['说明'], ['按模板填写']], '说明');
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['学号', '姓名'], ['001', '张三']]), '一班');
  assert.equal(parseRosterWorkbook(workbook).sheetName, '一班');
});
test('multiple matching sheets require an unambiguous choice', () => {
  const workbook = book([['学号', '姓名'], ['001', '张三']], '一班');
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['学号', '姓名'], ['002', '李四']]), '二班');
  assert.throws(() => parseRosterWorkbook(workbook), /多个工作表/);
});
test('actual XLSX bytes and UTF-8 CSV can both be parsed', () => {
  const data = write(book([['学号', '姓名'], ['001', '张三']]), { type: 'array', bookType: 'xlsx' });
  assert.equal(parseRosterFile(data, 'roster.xlsx').users[0].username, '001');
  const csv = new TextEncoder().encode('\uFEFF学号,姓名\n001,张三\n').buffer;
  assert.equal(parseRosterFile(csv, 'ROSTER.CSV').users[0].username, '001');
});
test('downloadable template uses the two required headers and formats IDs as text', () => {
  const workbook = read(readFileSync('public/student-roster-template.xlsx'), { type: 'buffer', cellNF: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.equal(sheet.A1.v, '学号'); assert.equal(sheet.B1.v, '姓名');
  assert.equal(sheet.A2.z, '@');
});
