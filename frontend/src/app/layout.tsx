import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOJ 教学平台",
  description: "基于 HOJ 的校内编程作业平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // 单一蓝白风格：变量在 globals.css 的 :root（深色为 data-theme="dark"），组件树对风格无感知。
    // data-theme 由 head 内联脚本在首屏前写入，与服务端 HTML 不同，因此不对 <html> 做水合比对。
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="stylesheet" href="/platform-shell.css" />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
