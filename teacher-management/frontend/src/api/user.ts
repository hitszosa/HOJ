import { instance as api } from "./axiosInstance";

export interface UserInfo {
  id: number;
  username: string;
  real_name: string;
  role: number;
  password_expired: boolean;
}

export interface FuzzyUserResult {
  result: UserInfo[];
  has_more_pages: boolean;
  length: number | null;
}

export function ApiCreateUser(userInfo: Omit<UserInfo, "id">) {
  return api.post<UserInfo>(`/api/users/`, userInfo);
}

// auth

export function ApiLogin(username: string, password: string) {
  return api.post("/api/auth/login/", { username, password });
}

export function ApiGetCurrentUser() {
  return api.get<UserInfo>("/api/auth/current_user/");
}

export function ApiClaimPasswordReminder() {
  return api.post<{ show: boolean }>("/api/auth/password_reminder/", {});
}

export function ApiLogout() {
  return api.post(`/api/auth/logout/`);
}

export function ApiChangePassword(oldpass: string, newpass: string) {
  return api.post(`/api/auth/change_password/`, {
    old_password: oldpass,
    new_password: newpass,
  });
}

// users

export function ApiGetUsersList() {
  return api.get<UserInfo[]>(`/api/users/`);
}

export interface BatchLookupResults {
  success: { user: UserInfo; idx: number }[];
  fail: { message: string; Idx: number }[];
}

export function ApiBatchLookupUsers(usernames: string[], ids: number[] = []) {
  return api.post<BatchLookupResults>(`/api/users/user_batch_lookup/`, {
    usernames,
    ids,
  });
}

export async function BatchLookupUsers(usernames: string[], ids: number[] = []) {
  if (usernames.length === 0 && ids.length === 0) {
    // 2604：后端会 400 拒绝此类请求，此情况直接做特判，给业务侧提供简便
    return { success: [], fail: [] };
  }
  return (await ApiBatchLookupUsers(usernames, ids)).data;
}

export function ApiGetUserInfo(id: number) {
  return api.get<UserInfo>(`/api/users/${id}/`);
}

export function ApiChangePasswordFor(username: string, password: string) {
  return api.post<UserInfo>(`/api/users/change_password/`, { username, password });
}

export function ApiSetUserInfo(id: number, userInfo: UserInfo) {
  return api.patch<UserInfo>(`/api/users/${id}/`, userInfo);
}

export function ApiDeleteUser(id: number) {
  return api.delete<UserInfo>(`/api/users/${id}/`);
}

export function ApiBatchCreateUser(u: Omit<UserInfo, "id">[]) {
  return api.post(`/api/users/batch_create/`, u);
}

export function ApiFuzzyUserLookup(
  key: string,
  page_size: number,
  page_num: number,
  role?: number,
  include_count?: boolean,
) {
  return api.get<FuzzyUserResult>("/api/users/user_fuzzy_lookup/", {
    params: { key, page_size, page_num, role, include_count },
  });
}
