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
  if (route.name === "draft") {
    if(data.offering_id==null){if(portal!=="teacher")throw new Error("403|只有教师可以管理个人题库");return {data,archived:false,ta:false};}
    offering = (await request(`/offerings/${data.offering_id}`)).offering;
  }
  else offering = offering || data.offering;
  if (endpoint !== "/courses") {
    const role = offering?.role || data.role;
    const sharedAssignment = route.name === "batch" || route.name === "workspace";
    const allowed = sharedAssignment ? ["student", "teacher", "ta"].includes(role)
      : portal === "student" ? role === "student" : ["teacher", "ta"].includes(role);
    if (!allowed) throw new Error("403|没有此课程的教学或选课权限");
    if (route.name === "draft" && role !== "teacher") throw new Error("403|只有任课教师可以管理题单");
  }
  return { data, archived: offering?.status === "archived" || data.archived === true, ta: offering?.role === "ta" };
}
