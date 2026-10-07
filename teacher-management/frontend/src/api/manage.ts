import { instance as api } from "./axiosInstance";

export interface SiteAnnouncement {
  enable: boolean;
  publish_date: string; // ISO datetime
  effective_until: string; // ISO datetime
  display: "snack" | "dialog" | "dialogPersistent";
  title: { zh: string; en: string };
  content: { zh: string; en: string };
}

export interface AuditAction {
  id: number;
  username: string;
  action: string;
  resource_type: string;
  created_at: string;
  ip_address: string;
  user_agent: string;
  affected_user_id?: number;
  course_id?: number;
  assignment_id?: number;
}

export function ApiGetRecentActions(limit = 10) {
  return api.get<AuditAction[]>("/api/manage/recent_actions/", {
    params: { limit },
  });
}

export function ApiGetAnnouncement() {
  return api.get<SiteAnnouncement | null>("/api/manage/announcement", {
    transformResponse: [
      (s) => JSON.parse(s),
      (
        sa:
          | null
          | (Omit<SiteAnnouncement, "title" | "content"> & {
              title: string;
              content: string;
            }),
      ) => {
        try {
          return sa && {
            ...sa,
            title: JSON.parse(sa.title),
            content: JSON.parse(sa.content),
          };
        } catch {
          return sa && {
            ...sa,
            title: { zh: sa.title, en: sa.title },
            content: { zh: sa.content, en: sa.content },
          };
        }
      },
    ],
  });
}

export function ApiUpdateAnnouncement(announcement: SiteAnnouncement) {
  return api.post<SiteAnnouncement>("/api/manage/announcement", {
    ...announcement,
    title: JSON.stringify(announcement.title),
    content: JSON.stringify(announcement.content),
  });
}
