import i18n from "@/plugins/i18n";
import type { UserInfo } from "@/api/user";
import { useAppStore } from "@/stores/app";
import axios from "axios";
import { AxiosError } from "axios";

let unauthorizedRedirectInFlight = false;

const instance = axios.create({
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
  xsrfHeaderName: "X-CSRFTOKEN",
  xsrfCookieName: "csrftoken",
});

instance.interceptors.request.use(
  (config) => {
    if (config.url?.startsWith("/api/")) {
      config.url = config.url.replace(/^\/api\//, "/management-api/");
    }
    return config;
  },
  (error) => {
    useAppStore().sendSnack(
      "很抱歉，请求出错了。请稍后再试。\n" + error?.message,
      "error",
    );
    return Promise.reject(error);
  },
);

export interface BackendError {
  error: string;
  message: string;
  code: number;
}

async function redirectToLoginAfterUnauthorized() {
  if (unauthorizedRedirectInFlight) {
    return;
  }

  unauthorizedRedirectInFlight = true;
  try {
    const { default: router } = await import("@/router");
    const currentRoute = router.currentRoute.value;

    if (!currentRoute.meta.no_login && currentRoute.name !== "login") {
      await router.replace({
        name: "login",
        query: { next: currentRoute.fullPath },
      });
    }
  } finally {
    unauthorizedRedirectInFlight = false;
  }
}

function shouldRedirectToLogin(error: AxiosError<BackendError>) {
  const url = error.config?.url ?? "";
  return !url.includes("/auth/current_user/");
}

instance.interceptors.response.use(
  (response) => {
    return response;
  },
  (error: AxiosError<BackendError>) => {
    const store = useAppStore();
    const { sendSnack } = store;
    const { t } = i18n.global;
    if (error.response?.status === 401 && !error.config?.url?.includes("/auth/change_password/")) {
      store.updateUser({} as UserInfo);
      if (shouldRedirectToLogin(error)) {
        void redirectToLoginAfterUnauthorized();
      }

      return Promise.reject(error);
    }

    if (error.response?.status.toString().startsWith("5")) {
      try {
        const r = error.response;
        const text = `(${r.status} ${r.statusText}) [${r.data.error}] ${r.data.message}`;
        sendSnack(t("error.responseGeneral") + "\n" + text, "error", -1);
      } catch {
        sendSnack(t("error.responseGeneral"), "error", -1);
        console.log(error.response);
      }
      return Promise.reject(error);
    }
    return Promise.reject(error);
  },
);

export { instance };
