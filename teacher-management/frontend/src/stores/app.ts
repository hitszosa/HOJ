// Utilities
import type { Course } from "@/api/course";
import type { UserInfo } from "@/api/user";
import { defineStore } from "pinia";
import i18n from "@/plugins/i18n";

export const useAppStore = defineStore("app", {
  state: () => ({
    user: {} as UserInfo,
    courseInfo: {} as Course,
    pageTransitionName: "fade",
    snack: {
      visible: false,
      message: "",
      type: "info",
      timeout: 6000,
      closable: true,
      progress: {
        show: false,
        indeterminate: true,
        value: 0,
      },
    },
  }),
  getters: {
    roleName() {
      const { locale } = i18n.global;
      if (this.user.role === undefined) {
        return "";
      }
      switch (this.user.role) {
        case 0:
          return locale.value === "en" ? "Student" : "学生";
        case 1:
          return locale.value === "en" ? "Teacher" : "教师";
        case 2:
          return locale.value === "en" ? "Admin" : "管理员";
        default:
          return locale.value === "en" ? "Other" : "其他";
      }
    },
    isAdmin: (state) => state.user.role === 2,
    isTeacher: (state) => {
      return state.user.role >= 1;
    },
    isStudent: (state) => {
      return state.user.role === 0;
    },
  },
  actions: {
    updateUser(newUser: UserInfo) {
      this.user = newUser;
    },

    sendSnack(
      text: string,
      type: "info" | "success" | "warning" | "error" = "info",
      timeout = 6000,
    ) {
      this.snack.message = text;
      this.snack.type = type;
      this.snack.timeout = timeout;
      this.snack.closable = true;
      this.snack.progress = {
        show: false,
        indeterminate: true,
        value: 0,
      };
      // 唯有关闭一次 snack bar，timeout 进度条才会重置
      this.snack.visible = false;
      nextTick().then(() => {
        this.snack.visible = true;
      });
    },
  },
});
