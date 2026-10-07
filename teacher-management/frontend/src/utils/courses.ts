import i18n from "@/plugins/i18n";

export function getTermName(term: number) {
  const { locale } = i18n.global;
  if (locale.value === "en") {
    return ["Spring", "Summer", "Fall"][term] || `${term + 1}th`;
  }
  return ["春季", "夏季", "秋季"][term] || `第 ${term + 1} `;
}

type BaseCourse = { year: number; term: number };
export function getYearTermName<C extends BaseCourse>({ year, term }: C) {
  const { t } = i18n.global;
  return t("yearTerm", { year, localizedTerm: getTermName(term) });
}

export function makeYearTermList<C extends BaseCourse>(courseList: C[]) {
  // 将课程按学年学期分组，并按学年学期由近及远排序
  return Object.entries(Object.groupBy(courseList, (x) => x.year + "-" + x.term))
    .sort()
    .reverse()
    .map(([key, courses]) => {
      const [year, term] = key.split("-").map((s) => parseInt(s));
      return { year, term, courses: courses! };
    });
}
