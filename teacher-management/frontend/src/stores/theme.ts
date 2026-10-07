import { defineStore } from "pinia";

const DISPLAY_MODES = ["list", "card"] as const;

export const usePreferenceStore = defineStore("theme", {
  state: () => ({
    // 当设置为 null 时，主题跟随系统
    selectedTheme: null as "light" | "dark" | null,
    justLoggedIn: false,
    dismissAnnouncementBefore: new Date(2025, 0, 1).toISOString(),
    // 当设置为 null 时，语言跟随系统
    language: null as "en" | "zh" | null,
    courseView: "card" as (typeof DISPLAY_MODES)[number],
  }),
  persist: true,
  getters: {
    nextDisplayMode: (state) =>
      DISPLAY_MODES[(DISPLAY_MODES.indexOf(state.courseView) + 1) % DISPLAY_MODES.length],
    themeName: (state) => {
      return (
        state.selectedTheme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      );
    },
  },
  actions: {
    cycleDisplayMode() {
      this.courseView = this.nextDisplayMode;
    },
    setTheme(value: "light" | "dark" | null) {
      this.selectedTheme = value;
    },
    getLocale() {
      return (
        this.language ||
        navigator.languages
          .map((s) => s.split("-")[0])
          .find((s) => s == "zh" || s == "en") ||
        "en"
      );
    },
  },
});
