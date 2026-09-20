/**
 * 单一蓝白风格的结构守卫（hustoj-portals-3：多风格已取消）。
 *
 * 保留两条不依赖皮肤切换的结构性断言：
 *   1. 组件源码里不得出现任何硬编码颜色 —— 颜色必须走 globals.css 的语义变量；
 *   2. 真实组件组合能正常渲染（换肤机制移除后，DOM 不应再出现 NaN 等渲染异常）。
 */

import { Badge, Card, CardTitle, Empty, EvidenceTag, Progress, Stat } from "@/components/ui";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(WEB_ROOT, "src");

function listFiles(dir: string, extensions = [".ts", ".tsx"]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...listFiles(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe("风格：不动组件", () => {
  it("组件源码里没有硬编码颜色", () => {
    // 调色板类名 + 十六进制 + 裸 rgb() 都是漏色的来源；
    // 允许的写法只有语义化 token 类（bg-surface / text-fg-muted / border-line …）
    const paletteClass =
      /(?:bg|text|border|from|to|via|ring|divide|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;
    const hexColor = /#[0-9a-fA-F]{3,8}\b/;
    const rawRgb = /\brgba?\s*\(/;

    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT)) {
      if (file.endsWith(".test.tsx") || file.endsWith(".test.ts") || file.endsWith("setup.ts")) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (
          paletteClass.test(line) ||
          hexColor.test(line) ||
          rawRgb.test(line)
        ) {
          offenders.push(`${relative(WEB_ROOT, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders, `以下位置绕过了设计 token，换肤会漏色：\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("风格：真实组件渲染", () => {
  it("组件组合能正常渲染出内容", () => {
    const { container } = render(
      <Card>
        <CardTitle title="示例卡片" meta="meta 文本" action={<Badge tone="brand">动作</Badge>} />
        <Badge tone="ok">已通过</Badge>
        <EvidenceTag kind="F" />
        <Stat label="提交次数" value={42} unit="次" tone="brand" />
        <Progress value={3} max={10} label="完成进度" />
        <Empty title="这里暂时没有内容" hint="提示文本" />
      </Card>,
    );
    const html = container.innerHTML;
    expect(html.length).toBeGreaterThan(200);
    expect(html).not.toContain("NaN");
  });
});
