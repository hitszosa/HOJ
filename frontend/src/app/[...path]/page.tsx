import { Platform } from "@/components/Platform";
import { matchRoute, redirectPath } from "@/lib/routes";
import { managedCoursePath } from "@/lib/managed-courses";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export default async function Page({ params, searchParams }: { params: Promise<{ path: string[] }>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const { path } = await params;
  const route = matchRoute(`/${path.join("/")}`);
  if (route.name === "not-found") notFound();
  if (route.name === "redirect") redirect(redirectPath(route.to, await searchParams));
  if (route.name === "managed-course") {
    if (!/^[1-9]\d*$/.test(route.oid)) notFound();
    const cookie = (await headers()).get("cookie") || "";
    if (!cookie) redirect("/management/login");
    const response = await fetch(`${process.env.MANAGEMENT_API_URL || "http://127.0.0.1:8101"}/api/hoj/links`, {
      headers: { cookie }, cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) redirect("/management/login");
    if (response.status === 403 || response.status === 404) notFound();
    if (!response.ok) throw new Error("课程关联暂时无法加载，请稍后重试");
    const destination = managedCoursePath(route.oid, await response.json());
    if (!destination) notFound();
    redirect(destination);
  }
  const cookie = (await headers()).get("cookie") || "";
  const login = `/management/login?next=${encodeURIComponent(redirectPath(`/${path.join("/")}`,await searchParams))}`;
  if (!cookie) redirect(login);
  const response = await fetch(`${process.env.COURSE_API_URL || "http://127.0.0.1:8100"}/api/me`, {
    headers:{cookie}, cache:"no-store", signal:AbortSignal.timeout(8000),
  });
  if (response.status === 401) redirect(login);
  if (!response.ok) throw new Error("登录身份暂时无法确认，请稍后重试");
  const identity = (await response.json()).data;
  if (["studio","draft","insights"].includes(route.name) && identity?.portal !== "teacher") redirect("/management/home");
  if(route.name==='status'&&identity?.roles?.some((role:string)=>role==='teacher'||role==='admin')) redirect('/management/courses');
  return <Platform/>;
}
