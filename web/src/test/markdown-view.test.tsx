import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "@/components/MarkdownView";

describe("MarkdownView 组件", () => {
  it("能渲染 Markdown 标题、列表与粗体", () => {
    const md = `
### 输入格式
只有一行，为一个字符串。

### 输出格式
- 第一行输出结果
- **第二行**结束
`;
    const { container } = render(<MarkdownView content={md} />);
    const h3List = container.querySelectorAll("h3");
    expect(h3List.length).toBe(2);
    expect(h3List[0].textContent).toBe("输入格式");
    expect(h3List[1].textContent).toBe("输出格式");

    const bold = container.querySelector("strong");
    expect(bold).toBeDefined();
    expect(bold?.textContent).toBe("第二行");

    const liList = container.querySelectorAll("li");
    expect(liList.length).toBe(2);
  });

  it("能渲染 KaTeX 行内数学公式与块级数学公式", () => {
    const md = `
给定正整数 $a, b$，数据范围 $1 \\le a, b \\le 10^9$。

$$
\\sum_{i=1}^n i^2
$$
`;
    const { container } = render(<MarkdownView content={md} />);
    const katexElements = container.querySelectorAll(".katex");
    expect(katexElements.length).toBeGreaterThanOrEqual(2);
  });

  it("代码块内部的内容不被当作数学公式转义", () => {
    const md = `
\`\`\`cpp
int $x = 100$;
\`\`\`
`;
    const { container } = render(<MarkdownView content={md} />);
    const code = container.querySelector("code");
    expect(code).toBeDefined();
    expect(code?.textContent).toContain("int $x = 100$;");
  });

  it("空内容时渲染占位提示", () => {
    render(<MarkdownView content="" placeholder="暂无题面详细描述" />);
    expect(screen.getByText("暂无题面详细描述")).toBeDefined();
  });
});
