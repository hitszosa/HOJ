"use client";

import { useSyncExternalStore } from "react";

/**
 * 深色模式与教学管理端（teacher-management）同源同步：
 * 两端共用 localStorage 的 "theme" 偏好（Pinia 持久化，selectedTheme 为 null 时跟随系统）。
 * 本端把结果写到 <html data-theme>，globals.css 与 platform-shell.css 据此切换配色变量。
 */
export type ThemeName = "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(): ThemeName {
  try {
    const selected = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}").selectedTheme;
    if (selected === "light" || selected === "dark") return selected;
  } catch {}
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(theme: ThemeName = resolveTheme()) {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
}

/**
 * 首屏绘制前执行的内联脚本（放在 <head>），避免先闪一下浅色。
 * 与 resolveTheme 逻辑相同；无法访问存储时按系统设置。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)})||"{}").selectedTheme}catch(e){}if(t!=="light"&&t!=="dark")t=window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches?"dark":"light";document.documentElement.dataset.theme=t})()`;

/** 跟随系统深浅色切换与其他标签页（如在管理端偏好设置里）修改主题。挂在应用外壳上一次即可。 */
export function watchTheme(): () => void {
  applyTheme();
  const media = window.matchMedia(DARK_QUERY);
  const sync = () => applyTheme();
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) sync();
  };
  media.addEventListener("change", sync);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", sync);
  return () => {
    media.removeEventListener("change", sync);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", sync);
  };
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** 当前生效的主题，供 echarts、ace 等不读 CSS 变量的组件使用。 */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light",
  );
}

/** 读取当前主题下的颜色变量（globals.css 中的 "r g b" 三元组），返回 rgb() 字符串。 */
export function themeColor(name: string, alpha = 1): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `rgb(${value} / ${alpha})` : "";
}
