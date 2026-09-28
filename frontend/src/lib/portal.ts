import type { Route } from "./routes";

type Row = Record<string, any>;
type Request = (path: string) => Promise<any>;

/** Resolve course authority before publishing a page, including its write controls. */
export async function loadPortalPage(endpoint: string, route: Route, portal: string, request: Request) {
  let offering: Row | undefined;
  if (route.name === "studio") {
    offering = (await request(`/offerings/${route.oid}`)).offering;
    if (offering?.role !== "teacher") throw new Error("403|只有任课教师可以管理题单");
  }
  const data = await request(endpoint);
  if (route.name === "draft") offering = (await request(`/offerings/${data.offering_id}`)).offering;
  else offering = offering || data.offering;
  if (endpoint !== "/courses") {
    const role = offering?.role || data.role;
    const allowed = portal === "student" ? role === "student" : ["teacher", "ta"].includes(role);
    if (!allowed) throw new Error("403|此课程不属于当前端的教学或选课关系");
    if ((route.name === "draft" || route.name === "classes") && role !== "teacher") throw new Error("403|只有任课教师可以管理班级与题单");
  }
  return { data, archived: offering?.status === "archived" || data.archived === true, ta: offering?.role === "ta" };
}
