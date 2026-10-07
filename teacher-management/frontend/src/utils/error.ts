import { BackendError } from "@/api/axiosInstance";
import i18n from "@/plugins/i18n";
import { AxiosError } from "axios";

export function getGeneralErrorMsg(e: AxiosError<BackendError>) {
  const { t, te } = i18n.global;

  if (e.response) {
    const kind = e.response.data.error;
    if (typeof kind !== "string") {
      return t(`error.general`);
    }

    const key = `error.${kind}`;
    if (te(key)) {
      return t(key);
    }
    return (
      t(`error.general`) +
      ` (${e.response.status} ${e.response.statusText})\n` +
      `[${kind}] ${e.response.data.message}`
    );
  } else if (e.request) {
    console.log("[!] probably a network error:", e);
    return t(`error.checkNetwork`) + `[${e.code}] ${e.message}`;
  }

  console.log("[!] probably axios request setup error:", e);
  return t(`error.general`);
}
