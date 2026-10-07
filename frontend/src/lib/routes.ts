/** One platform. Old portal URLs redirect to shared pages; course links retain authorized ID mapping. */
export type Route =
  | { name: "home" }
  | { name: "redirect"; to: string }
  | { name: "managed-course"; oid: string }
  | { name: "library" }
  | { name: "status" }
  | { name: "problem"; pid: string }
  | { name: "batch"; bid: string }
  | { name: "workspace"; bid: string; pid: string }
  | { name: "studio"; oid: string }
  | { name: "draft"; did: string }
  | { name: "insights"; oid: string }
  | { name: "not-found" };

export function matchRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const [a,b,c,d,e] = parts;
  if (!a) return { name:"home" };
  if (parts.length === 1) {
    if (a === "library") return { name:"library" };
    if (a === "judging") return { name:"status" };
    if (["student","teacher","history"].includes(a)) return { name:"redirect", to:"/management/courses" };
    if (a === "faq") return { name:"redirect", to:"/management/docs" };
    if (a === "themes") return { name:"redirect", to:"/management/home" };
    if (["category.php","categories"].includes(a)) return { name:"redirect", to:"/library?view=public" };
  }
  if (a === "library" && b === "problems" && c && parts.length === 3) return { name:"problem", pid:c };
  if (a === "assignments" && b && parts.length === 2) return { name:"batch", bid:b };
  if (a === "assignments" && b && c === "problems" && d && parts.length === 4) return { name:"workspace", bid:b, pid:d };
  if (a === "programming" && c && parts.length === 3) {
    if (b === "offerings") return { name:"studio", oid:c };
    if (b === "drafts") return { name:"draft", did:c };
    if (b === "grades") return { name:"insights", oid:c };
  }
  if (a === "courses" && b && parts.length === 2) return { name:"managed-course", oid:b };
  if (a === "batches" && b && parts.length === 2) return { name:"redirect", to:`/assignments/${b}` };
  if (a === "batches" && b && c === "problems" && d && parts.length === 4) return { name:"redirect", to:`/assignments/${b}/problems/${d}` };
  if (a === "student" || a === "teacher") {
    if (parts.length === 2) {
      if (a === "student" && b === "history") return { name:"redirect", to:"/management/courses" };
      if (b === "status") return { name:"redirect", to:"/judging" };
      if (b === "categories" || (a === "student" && b === "problems")) return { name:"redirect", to:"/library?view=public" };
      if (a === "teacher" && ["library","problems","problem-sets"].includes(b)) return { name:"redirect", to:"/library?view=mine" };
    }
    if (parts.length === 3 && c) {
      if (b === "courses" || (a === "teacher" && b === "classes")) return { name:"managed-course", oid:c };
      if (b === "batches") return { name:"redirect", to:`/assignments/${c}` };
      if (a === "student" && b === "problems") return { name:"redirect", to:`/library/problems/${c}` };
      if (a === "teacher" && ["offerings","drafts","insights"].includes(b)) return { name:"redirect", to:`/programming/${b === "insights" ? "grades" : b}/${c}` };
    }
    if (parts.length === 4 && a === "student" && b === "categories" && c === "problems" && d) return { name:"redirect", to:`/library/problems/${d}` };
    if (parts.length === 5 && b === "batches" && c && d === "problems" && e) return { name:"redirect", to:`/assignments/${c}/problems/${e}` };
  }
  return { name:"not-found" };
}
/** Authoring and grade pages require a teaching role; shared assignment pages resolve course authority. */
export function routePortal(route: Route): "teacher" | null {
  return ["studio","draft","insights"].includes(route.name) ? "teacher" : null;
}
/** Preserve course selection and filters when migrating old bookmarks. */
export function redirectPath(destination: string, query: Record<string, string | string[] | undefined> = {}) {
  const url = new URL(destination,"http://platform.local");
  for (const [key,value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key,item);
  }
  return url.pathname + url.search;
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
