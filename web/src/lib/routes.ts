/**
 * 前端路由表 —— 单一事实来源。
 *
 * app/[...path]/page.tsx 会捕获所有路径，因此「未知路由」必须在应用层显式判定：
 * 命中的路由才渲染对应视图，否则给出明确的「页面未找到」状态。
 *
 * hustoj-portals-3：教师端与学生端彻底分离，URL 也归属各端：
 * - 学生端：/student、/student/history、/student/courses/:oid、
 *   /student/batches/:bid、/student/batches/:bid/problems/:pid
 * - 教师端：/teacher、/teacher/courses/:oid、/teacher/batches/:bid，
 *   以及出题 /teacher/offerings/:oid、/teacher/drafts/:did、/teacher/insights/:oid
 * - 旧公共链接不直接渲染：legacy-* 路由由 Platform 按 me.portal 迁到对应端的同名路径；
 *   /history → /student/history，/themes（已取消）→ /。
 */

export type Route =
  | { name: "home" }
  | { name: "redirect"; to: string }
  | { name: "faq" }
  | { name: "student" }
  | { name: "student-history" }
  | { name: "student-status" }
  | { name: "student-ranklist" }
  | { name: "student-problems" }
  | { name: "student-categories" }
  | { name: "student-problem-detail"; pid: string }
  | { name: "student-course"; oid: string }
  | { name: "student-batch"; bid: string }
  | { name: "student-workspace"; bid: string; pid: string }
  | { name: "teacher" }
  | { name: "teacher-categories" }
  | { name: "teacher-status" }
  | { name: "teacher-ranklist" }
  | { name: "teacher-course"; oid: string }
  | { name: "teacher-batch"; bid: string }
  | { name: "teacher-workspace"; bid: string; pid: string }
  | { name: "studio"; oid: string }
  | { name: "draft"; did: string }
  | { name: "insights"; oid: string }
  | { name: "classes"; oid: string }
  | { name: "legacy-course"; oid: string }
  | { name: "legacy-batch"; bid: string }
  | { name: "legacy-workspace"; bid: string; pid: string }
  | { name: "legacy-categories" }
  | { name: "not-found" };

export function matchRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const [a, b, c, d] = parts;
  if (!a) return { name: "home" };
  // 通用 FAQ
  if (parts.length === 1 && a === "faq") return { name: "faq" };
  // 旧链接迁移
  if (parts.length === 1 && a === "history") return { name: "redirect", to: "/student/history" };
  if (parts.length === 1 && a === "themes") return { name: "redirect", to: "/" };
  if (parts.length === 1 && (a === "category.php" || a === "categories")) return { name: "legacy-categories" };
  // 学生端
  if (parts.length === 1 && a === "student") return { name: "student" };
  if (parts.length === 2 && a === "student" && b === "history") return { name: "student-history" };
  if (parts.length === 2 && a === "student" && b === "status") return { name: "student-status" };
  if (parts.length === 2 && a === "student" && b === "ranklist") return { name: "student-ranklist" };
  if (parts.length === 2 && a === "student" && b === "problems") return { name: "student-problems" };
  if (parts.length === 2 && a === "student" && b === "categories") return { name: "student-categories" };
  if (parts.length === 3 && a === "student" && b === "problems" && c)
    return { name: "student-problem-detail", pid: c };
  if (parts.length === 3 && a === "student" && b === "courses" && c)
    return { name: "student-course", oid: c };
  if (parts.length === 3 && a === "student" && b === "batches" && c)
    return { name: "student-batch", bid: c };
  if (parts.length === 5 && a === "student" && b === "batches" && c && d === "problems" && parts[4])
    return { name: "student-workspace", bid: c, pid: parts[4] };
  // 教师端
  if (parts.length === 1 && a === "teacher") return { name: "teacher" };
  if (parts.length === 2 && a === "teacher" && b === "categories") return { name: "teacher-categories" };
  if (parts.length === 2 && a === "teacher" && b === "status") return { name: "teacher-status" };
  if (parts.length === 2 && a === "teacher" && b === "ranklist") return { name: "teacher-ranklist" };
  if (parts.length === 3 && a === "teacher" && b === "courses" && c)
    return { name: "teacher-course", oid: c };
  if (parts.length === 3 && a === "teacher" && b === "batches" && c)
    return { name: "teacher-batch", bid: c };
  if (parts.length === 5 && a === "teacher" && b === "batches" && c && d === "problems" && parts[4])
    return { name: "teacher-workspace", bid: c, pid: parts[4] };
  if (parts.length === 3 && a === "teacher" && b === "offerings" && c)
    return { name: "studio", oid: c };
  if (parts.length === 3 && a === "teacher" && b === "drafts" && c)
    return { name: "draft", did: c };
  if (parts.length === 3 && a === "teacher" && b === "insights" && c)
    return { name: "insights", oid: c };
  if (parts.length === 3 && a === "teacher" && b === "classes" && c)
    return { name: "classes", oid: c };
  // 旧公共详情链接：按 me.portal 迁移（Platform 处理）
  if (parts.length === 2 && a === "courses" && b) return { name: "legacy-course", oid: b };
  if (parts.length === 2 && a === "batches" && b) return { name: "legacy-batch", bid: b };
  if (parts.length === 4 && a === "batches" && b && c === "problems" && d)
    return { name: "legacy-workspace", bid: b, pid: d };
  return { name: "not-found" };
}

/** 路由所属端：错端访问由 Platform 跳回 me.home；null 表示需在 Platform 内再判定（legacy / faq）。 */
export function routePortal(route: Route): "student" | "teacher" | null {
  switch (route.name) {
    case "student":
    case "student-history":
    case "student-status":
    case "student-ranklist":
    case "student-problems":
    case "student-categories":
    case "student-problem-detail":
    case "student-course":
    case "student-batch":
    case "student-workspace":
      return "student";
    case "teacher":
    case "teacher-categories":
    case "teacher-status":
    case "teacher-ranklist":
    case "teacher-course":
    case "teacher-batch":
    case "teacher-workspace":
    case "studio":
    case "draft":
    case "insights":
    case "classes":
      return "teacher";
    default:
      return null;
  }
}

/** 代码草稿的 localStorage key：按用户 + 批次 + 题目隔离，身份切换互不串号。 */
export function draftStorageKey(user: string, bid: string, pid: string): string {
  return `code:${user || "anon"}:${bid}:${pid}`;
}

export function readDraft(user: string, bid: string, pid: string): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(draftStorageKey(user, bid, pid)) ?? "";
}

export function writeDraft(user: string, bid: string, pid: string, code: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(draftStorageKey(user, bid, pid), code);
}
