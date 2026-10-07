import { redirect } from "next/navigation";
import { redirectPath } from "@/lib/routes";
export default async function Page({params,searchParams}:{params:Promise<{batchId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const {batchId}=await params;
 redirect(redirectPath(`/assignments/${batchId}`,await searchParams));
}
