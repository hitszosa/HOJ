import axios from "axios";
import { instance as api } from "./axiosInstance";
import { AxiosProgressEvent } from "axios";

export function ApiTouchFile(
  original_file_name: string,
  reason: { type: string; [key: string]: any },
) {
  return api.post<{
    ident: string;
    url: string;
    params: object;
  }>("/api/files/touch/", { original_file_name, ident: reason });
}

export function S3UploadFile(
  url: string,
  fields: object,
  file: File,
  onUploadProgress?: (e: AxiosProgressEvent) => void,
) {
  return axios.postForm(url, { ...fields, file }, { onUploadProgress, timeout: 4e6 });
}

export function ApiFinishFile(ident: string) {
  return api.post("/api/files/finish/", { ident });
}

export function ApiDownloadFile(ident: string) {
  return api.post<{ ident: string; url: string; original_file_name: string }>(
    "/api/files/download/",
    { ident },
  );
}

export function S3DownloadFile(
  url: string,
  onDownloadProgress?: (e: AxiosProgressEvent) => void,
) {
  return api.get(url, { responseType: "blob", onDownloadProgress, timeout: 1e7 });
}

export function ApiCleanupUnusedUploads() {
  return api.post("/api/file/cleanup_unused_uploads");
}
