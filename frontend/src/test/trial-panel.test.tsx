import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrialPanel } from "@/components/TrialPanel";

const props = { bid: "10", pid: "1025", code: "print(42)", language: "python", sampleInput: "12 30\n", sampleOutput: "42\n" };
const result = { state: "finished", result: 13, label: "自测结束", time: 10, memory: 0, output: "42\n", compileError: "", truncated: false };
function response(data: unknown, ok = true) { return { ok, json: async () => data } as Response; }
afterEach(() => vi.unstubAllGlobals());

describe("提交前自测", () => {
  it("固定发送题目样例，仅调用自测接口并展示真实输出", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ runId: "signed-token" })).mockResolvedValueOnce(response(result));
    vi.stubGlobal("fetch", fetcher);
    render(<TrialPanel {...props} />);
    expect(screen.getByLabelText("样例输入")).toHaveTextContent("12 30");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复题目样例" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行自测" }));
    await waitFor(() => expect(screen.getByLabelText("自测运行输出")).toHaveTextContent("42"));
    expect(fetcher.mock.calls[0][0]).toBe("/api/batches/10/problems/1025/trials");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ code: "print(42)", language: "python", input: "12 30\n" });
    expect(fetcher.mock.calls[1][0]).toBe("/api/trials/signed-token");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/submissions"))).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("自测结束");
  });

  it("编译错误单独显示，不把结束当作通过", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ runId: "ce" })).mockResolvedValueOnce(response({ ...result, result: 11, label: "编译错误", output: "", compileError: "SyntaxError: invalid syntax", truncated: true })));
    render(<TrialPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "运行自测" }));
    await waitFor(() => expect(screen.getByLabelText("自测运行输出")).toHaveTextContent("SyntaxError"));
    expect(screen.getByRole("status")).toHaveTextContent("编译错误");
    expect(screen.getByRole("status")).toHaveTextContent("已截断");
  });

  it("超限输入在本地拦截，归档页不开放运行", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const view = render(<TrialPanel {...props} sampleInput={"中".repeat(6000)} />);
    fireEvent.click(screen.getByRole("button", { name: "运行自测" }));
    expect(screen.getByRole("alert")).toHaveTextContent("16KB");
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<TrialPanel {...props} disabled />);
    expect(screen.getByRole("button", { name: "运行自测" })).toBeDisabled();
  });

  it("代码变化后明确标识旧结果，不冒充新代码输出", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ runId: "slow" })).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
    const view = render(<TrialPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "运行自测" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<TrialPanel {...props} code="print(99)" />);
    await act(async () => { finish(response(result)); });
    expect(screen.getByText(/下面是上一次运行的结果/)).toBeVisible();
  });
});
