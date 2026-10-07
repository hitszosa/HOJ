import router from "@/router";
import i18n from "@/plugins/i18n";

const GRADER_APP_NAME = "HOJ 教学平台";

export function setDocumentTitle(extraSections: string[] = []) {
  const { locale } = i18n.global;
  const pageTitle =
    (locale.value === "en" && router.currentRoute.value.meta.titleEn) ||
    router.currentRoute.value.meta.title;
  const sections = extraSections.concat([
    ...[pageTitle].filter((i) => typeof i === "string"),
    GRADER_APP_NAME,
  ]);
  document.title = sections.join(" | ");
}
