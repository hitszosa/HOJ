import type { Assignment } from "@/api/course";

export function parseExtensions(value: string | null | undefined): string[] {
  return [...new Set(
    (value ?? "")
      .toLowerCase()
      .split(/[\s,;/，；]+/)
      .map((extension) => extension.replace(/^\.+/, ""))
      .filter(Boolean),
  )];
}

/** 根据作业的紧迫性和能否提交状态确定显示颜色。
 */
export function getDueTimeColor(dueDate: Date, disabled = false) {
  if (disabled) {
    return "grey-lighten-1";
  }
  const now = new Date().getTime();
  const dt = (dueDate.getTime() - now) / 1000; // (秒)

  if (dt < 0) {
    return "grey";
  }
  if (dt < 4 * 60 * 60) {
    // 少于四小时
    return "deep-orange-darken-2";
  } else if (dt < 2 * 24 * 60 * 60) {
    // 少于两天
    return "orange-darken-1";
  } else if (dt < 4 * 24 * 60 * 60) {
    // 少于4天
    return "lime-darken-2";
  } else {
    // 时间充足
    return "green-lighten-1";
  }
}

export function parseDate(date: string | Date) {
  return typeof date === "string" ? new Date(date) : date;
}

export function isDue(a: Assignment) {
  return parseDate(a.due_time) <= new Date(/* now */);
}

export function hasBegun(a: Assignment) {
  return parseDate(a.start_time) <= new Date(/* now */);
}
