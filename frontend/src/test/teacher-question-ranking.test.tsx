import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {TeacherQuestionRanking} from '@/components/TeacherQuestionRanking';
import {api} from '@/lib/api';
import type {BatchDetail} from '@/api/generated/BatchDetail';
vi.mock('@/lib/api',async importOriginal=>({...await importOriginal<typeof import('@/lib/api')>(),api:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const data={batch:{batch_id:7},offering:{role:'teacher'},problems:[{problem_id:8,title:'加法',seq:1},{problem_id:9,title:'乘法',seq:2}]} as BatchDetail;
const student={user_id:'s1',student_no:'001',nick:'学生甲',rank:1,score:100,label:'AC',attempts:2,submission_id:99};
it('学生与助教均无榜单，也不读取接口',()=>{for(const role of ['student','ta']){const r=render(<TeacherQuestionRanking data={{...data,offering:{...data.offering,role}} as BatchDetail}/>);expect(screen.queryByText(/排行榜/)).toBeNull();r.unmount();}expect(api).not.toHaveBeenCalled();});
it('教师显式展开，分页和换题读取对应班级题目，代码使用最佳提交',async()=>{
 vi.mocked(api).mockImplementation(async path=>path.endsWith('/code')?{code:'best AC source',result_label:'AC',language_name:'C++'}:{page:1,page_size:20,total:23,students:[student]} as any);
 render(<TeacherQuestionRanking data={data}/>);expect(api).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'查看每题排行榜'}));await screen.findByText('学生甲');expect(api).toHaveBeenCalledWith('/batches/7/problems/8/teacher-ranking?page=1&page_size=20');
 fireEvent.click(screen.getByRole('button',{name:'查看代码'}));await screen.findByText('best AC source');expect(api).toHaveBeenCalledWith('/submissions/99/code');fireEvent.click(screen.getByRole('button',{name:'关闭代码'}));
 vi.mocked(api).mockResolvedValue({page:2,page_size:20,total:23,students:[{...student,nick:'学生乙'}]});fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('学生乙');expect(api).toHaveBeenCalledWith('/batches/7/problems/8/teacher-ranking?page=2&page_size=20');
 vi.mocked(api).mockResolvedValue({page:1,page_size:20,total:23,students:[student]});fireEvent.change(screen.getByLabelText('排行榜题目'),{target:{value:'9'}});await waitFor(()=>expect(api).toHaveBeenLastCalledWith('/batches/7/problems/9/teacher-ranking?page=1&page_size=20'));
});
it('换题后迟到的旧榜单不会覆盖新结果',async()=>{let resolveOld:(data:any)=>void=()=>{};vi.mocked(api).mockImplementation(async path=>path.includes('/8/')?new Promise(resolve=>{resolveOld=resolve;}):{page:1,page_size:20,total:1,students:[{...student,nick:'新题学生'}]} as any);render(<TeacherQuestionRanking data={data}/>);fireEvent.click(screen.getByRole('button',{name:'查看每题排行榜'}));await waitFor(()=>expect(api).toHaveBeenCalledOnce());fireEvent.change(screen.getByLabelText('排行榜题目'),{target:{value:'9'}});await screen.findByText('新题学生');resolveOld({page:1,page_size:20,total:1,students:[student]});await new Promise(resolve=>setTimeout(resolve,0));expect(screen.queryByText('学生甲')).toBeNull();expect(screen.getByText('新题学生')).toBeInTheDocument();});
