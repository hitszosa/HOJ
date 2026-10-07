/**
 * router/index.ts
 *
 * Automatic routes for `./src/pages/*.vue`
 */

// Composables
import { createRouter, createWebHistory } from "vue-router";
import { routes } from "vue-router/auto-routes";
import { setupLayouts } from "virtual:generated-layouts";
import { useAppStore } from "@/stores/app";
import { ApiGetCurrentUser } from "@/api/user";
import { setDocumentTitle } from "@/utils/page";
import { managementPageAllowed } from "../../../../frontend/src/lib/platform-navigation";
import { getGeneralErrorMsg } from "@/utils/error";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: setupLayouts(
    routes.concat([
      { path: "/", redirect: { name: "courses-list" } },
      { path: "/admin2/courses", redirect: { name: "courses-list" } },
      { path: "/admin2/dashboard", redirect: { name: "home" } },
      { path: "/admin2/storage", redirect: { name: "home" } },
    ]),
  ),
});

router.beforeEach(async (to, from) => {
  const store = useAppStore();

  if (!store.user.username && !to.meta.no_login) {
    try {
      const response = await ApiGetCurrentUser();
      store.updateUser(response.data);
    } catch (error: any) {
      store.sendSnack(getGeneralErrorMsg(error), "warning");
      return { name: "login", query: { next: to.fullPath }, replace: true };
    }
  }
  if (!managementPageAllowed(store.user.role, to.path)) {
    store.sendSnack("您没有权限访问此页面", "error");
    return { name: "home", replace: true };
  }
  return true;
});

router.afterEach((to, from, failure) => {
  if (failure) return;
  const store = useAppStore();
  // 根据路由方向决定页面过渡动效
  if (to.path.startsWith(from.path)) {
    store.pageTransitionName = "scroll-x-reverse";
  } else if (from.path.startsWith(to.path)) {
    store.pageTransitionName = "scroll-x";
  } else {
    store.pageTransitionName = "fade";
  }
  // 改变页面标题
  setDocumentTitle();
});

export default router;
