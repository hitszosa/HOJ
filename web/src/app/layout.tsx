import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "HUSTOJ 教学平台",
  description: "基于 HUSTOJ 的校内编程作业平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // 单一蓝白风格：变量固定在 globals.css 的 :root，组件树对风格无感知
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
