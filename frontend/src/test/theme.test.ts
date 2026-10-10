import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_INIT_SCRIPT, resolveTheme, watchTheme } from "@/lib/theme";

let systemDark = false;
let mediaListener: (() => void) | null = null;

beforeEach(() => {
  systemDark = false;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") && systemDark,
    addEventListener: (_: string, fn: () => void) => (mediaListener = fn),
    removeEventListener: () => (mediaListener = null),
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** 教学管理端（Pinia 持久化）写入的偏好格式。 */
const savePreference = (selectedTheme: "light" | "dark" | null) =>
  localStorage.setItem("theme", JSON.stringify({ selectedTheme, language: "zh" }));

describe("深色模式与管理端同步", () => {
  it("优先使用管理端保存的主题，未设置时跟随系统", () => {
    systemDark = true;
    expect(resolveTheme()).toBe("dark");
    savePreference("light");
    expect(resolveTheme()).toBe("light");
    savePreference(null);
    expect(resolveTheme()).toBe("dark");
    localStorage.setItem("theme", "{broken");
    expect(resolveTheme()).toBe("dark");
  });

  it("首屏内联脚本与 resolveTheme 结果一致", () => {
    savePreference("dark");
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("dark");
    savePreference(null);
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("跟随系统切换与其他标签页修改偏好", () => {
    const stop = watchTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    systemDark = true;
    mediaListener?.();
    expect(document.documentElement.dataset.theme).toBe("dark");
    savePreference("light");
    window.dispatchEvent(new StorageEvent("storage", { key: "theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    stop();
  });
});
