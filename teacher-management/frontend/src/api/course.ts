import { instance as api } from "./axiosInstance";
import { UserInfo } from "./user";
import { format, parseISO } from "date-fns";

export interface Assignment {
  id: number;
  title: string;
  course: number;
  published: boolean;
  start_time: string;
  due_time: string;
  description: string;
  allowed_extension: string;
  submit_allowed: boolean;
  submit_count: number;
  score: number;
  show_score: boolean;
  max_file_size: number;
}

export interface Course {
  id: number;
  year: number;
  term: number;
  title: string;
  teachers: UserInfo[];
  assistants: number[];
  students: number[];
}

export interface CourseWithAssignments extends Course {
  id: number;
  title: string;
  teachers: UserInfo[];
  recent_assignments: Assignment[];
  year: number;
  term: number;
  assistants: number[];
  programming: ProgrammingSummary;
}

export interface ProgrammingWork {
  batch_id: number; title: string; status: string;
  open_at: string | null; due_at: string | null; accepting: boolean;
}
export interface ProgrammingSummary {
  offering_id?: number; assignment_count: number; open_count: number; recent: ProgrammingWork[];
}

export function ApiGetCoursesList(all = true) {
  return api.get<Course[]>("/api/courses/", {
    params: { all },
  });
}

export async function ApiGetCoursesListWithRecentAssignments() {
  const [courses,links,response] = await Promise.all([
    api.get<CourseWithAssignments[]>("/api/courses/with_recent_assignments/"),
    api.get<{course_id:number;offering_id:number}[]>("/api/hoj/links"),
    fetch('/api/management/assignment-overview',{credentials:'same-origin'}),
  ]);
  const body=await response.json();
  if(!response.ok)throw Error(body.message || '编程作业统计暂时无法加载');
  const summaries=new Map<number,ProgrammingSummary>((body.data as ProgrammingSummary[]).map(s=>[s.offering_id!,s]));
  const offerings=new Map(links.data.map(link=>[link.course_id,link.offering_id]));
  courses.data=courses.data.map(course=>({...course,programming:summaries.get(offerings.get(course.id)!) || {offering_id:offerings.get(course.id),assignment_count:0,open_count:0,recent:[]}}));
  return courses;
}

export function FormatDate(date: string | Date) {
  if (typeof date === "string") {
    return format(parseISO(date), "yyyy-MM-dd HH:mm");
  } else if (date instanceof Date) {
    return format(date, "yyyy-MM-dd HH:mm");
  }
}

export function FormatDateToISO(date: string | Date) {
  if (typeof date === "string") {
    return parseISO(date).toISOString();
  } else if (date instanceof Date) {
    return date.toISOString();
  }
}

export function ApiDeleteAssignment(assignmentId: string | number) {
  return api.delete(`/api/assignments/${assignmentId}/`);
}

export function ApiGetCourseAssignments(courseId: string | number) {
  return api.get<Assignment[]>(`/api/assignments/`, {
    params: { course: String(courseId) },
  });
}

export function ApiGetCourseInfo(courseId: string | number) {
  return api.get<Course>(`/api/courses/${courseId}/`);
}

export interface Submission {
  id: number;
  user: UserInfo;
  submit_time: string;
  status: 0 | 1;
  score: number | null;
  assignment: number;
  file: string;
}

export function ApiGetSubmissions(
  courseId: string | number,
  assignmentId?: string | number,
) {
  return api.get<Submission[]>("/api/submissions/", {
    params: {
      course: `${courseId}`,
      ...(assignmentId && { assignment: `${assignmentId}` }),
    },
  });
}

export interface AssignmentInfo {
  title: string;
  course: string | number;
  start_time: string | Date;
  due_time: string | Date;
  show_score?: boolean;
  type?: number;
}

export function ApiCreateAssignment(i: AssignmentInfo) {
  return api.post<Assignment>(`/api/assignments/`, {
    title: i.title,
    course: String(i.course),
    start_time: FormatDateToISO(i.start_time),
    due_time: FormatDateToISO(i.due_time),
    show_score: i.show_score ?? false,
    type: i.type,
    max_file_size: 104857600
  });
}

export function ApiUpdateAssignment(assignmentId: string | number, i: AssignmentInfo) {
  return api.put<Assignment>(`/api/assignments/${assignmentId}/`, {
    title: i.title,
    course: String(i.course),
    start_time: FormatDateToISO(i.start_time),
    due_time: FormatDateToISO(i.due_time),
    show_score: i.show_score,
  });
}

export function ApiGetAssignmentInfo(assignmentId: string | number) {
  return api.get<Assignment>(`/api/assignments/${assignmentId}/`);
}

export function ApiTeacherPublishAssignment(assignmentId: number | string) {
  return api.post(`/api/assignments/${assignmentId}/publish/`);
}

export interface QuestionInfo {
  score: number;
  show_score: boolean;
  description: string;
  allowed_extension: string;
}

export function ApiTeacherModifyAssignment(
  assignmentId: number | string,
  questionInfo: QuestionInfo,
) {
  return api.patch(`/api/assignments/${assignmentId}/`, questionInfo);
}

export function ApiCreateSubmission(assignmentId: string | number, file_ident: string) {
  return api.post(
    `/api/submissions/`,
    {},
    {
      params: { assignment: assignmentId, file_ident },
    },
  );
}

export function ApiGetNoSubmissionStudentList(
  courseId: string | number,
  assignmentId: string | number,
) {
  return api.get<UserInfo[]>(
    `/api/submissions/no_submission_students/?course=${courseId}&assignment=${assignmentId}`,
  );
}

export function ApiGetSubmissionInfo(submissionId: string | number) {
  return api.get<Submission>(`/api/submissions/${submissionId}/`);
}

export function ApiUpdateScore(submissionId: number, score: number) {
  return api.post<Submission & { score: number }>("/api/submissions/score_update/", {
    submission: submissionId,
    score,
  });
}

export interface AssignmentStatistics {
  id: number;
  average: number;
  highest: number;
  lowest: number;
  median: number;
}

export function ApiAssignmentStatistics(assignmentId: string | number) {
  return api.get<AssignmentStatistics>(`/api/assignments/${assignmentId}/statistics/`);
}

export function ApiCourseStatistics(courseId: string | number) {
  return api.get<AssignmentStatistics[]>(`/api/courses/${courseId}/statistics/`);
}

export interface CourseInfo {
  id?: number;
  year: number;
  term: number;
  title: string;
  teachers: number[];
  assistants: number[];
  students: number[];
}

export function ApiCreateCourse(courseInfo: CourseInfo) {
  return api.post<CourseInfo>(`/api/courses/`, {
    year: courseInfo.year,
    term: courseInfo.term,
    title: courseInfo.title,
    teacher_ids: courseInfo.teachers,
    assistant_ids: courseInfo.assistants,
    student_ids: courseInfo.students,
  });
}

export function ApiDeleteCourse(id: number) {
  return api.delete(`/api/courses/${id}/`);
}

export function ApiUpdateCourse(id: number, courseInfo: CourseInfo, rosterOnly = false) {
  return api.put<CourseInfo>(`/api/courses/${id}/`, {
    ...(!rosterOnly ? {year: courseInfo.year, term: courseInfo.term,
      title: courseInfo.title, teacher_ids: courseInfo.teachers} : {}),
    assistant_ids: courseInfo.assistants,
    student_ids: courseInfo.students,
  });
}
