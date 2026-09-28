/**
 * 基础组件层 —— 对应规划 v3.0 §2.2 里「以 codemind/apps/web/src/components/ui/ 为骨架」的决定。
 *
 * 铁律：这里**不允许出现任何硬编码颜色、圆角、间距、字号**，全部走 tailwind.config.ts
 * 里映射到 CSS 变量的语义化工具类（bg-surface / text-fg-muted / rounded-card / p-card …）。
 * 一旦违反，换肤就会漏色，src/test/skin.test.tsx 的结构一致性断言会失败。
 */

import { cn } from "@/lib/cn";
import type { HTMLAttributes, ReactNode } from "react";

type Tone = "brand" | "ok" | "warn" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-surface-muted text-fg-muted",
};

export function Card({
  children,
  className,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "article" | "div";
} & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        "rounded-card border border-line bg-surface shadow-card p-card",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({
  title,
  meta,
  action,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-inline flex items-start justify-between gap-inline">
      <div className="min-w-0">
        <h2 className="text-title font-semibold text-fg">{title}</h2>
        {meta ? <p className="mt-1 text-meta text-fg-muted">{meta}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill px-2 py-0.5 text-meta font-medium",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "secondary",
  onClick,
  type = "button",
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const variants = {
    primary: "bg-brand text-brand-fg hover:opacity-90",
    secondary: "border border-line bg-surface text-fg hover:bg-surface-muted",
    ghost: "text-fg-muted hover:bg-surface-muted",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-control px-3 py-1.5 text-meta font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        variants[variant],
      )}
    >
      {children}
    </button>
  );
}

export function Progress({
  value,
  max = 100,
  tone = "brand",
  label,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill: Record<Tone, string> = {
    brand: "bg-brand",
    ok: "bg-ok",
    warn: "bg-warn",
    danger: "bg-danger",
    neutral: "bg-fg-subtle",
  };
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-muted"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cn("h-full rounded-pill", fill[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
}) {
  const valueTone: Record<Tone, string> = {
    brand: "text-brand",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    neutral: "text-fg",
  };
  return (
    <div className="rounded-card border border-line bg-surface-raised px-card py-inline">
      <div className="text-meta text-fg-muted">{label}</div>
      <div className={cn("mt-1 text-display font-semibold", valueTone[tone])}>
        {value}
        {unit ? <span className="ml-1 text-meta font-normal text-fg-muted">{unit}</span> : null}
      </div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-surface-muted p-card text-center">
      <p className="text-body text-fg-muted">{title}</p>
      {hint ? <p className="mt-1 text-meta text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

/** 三类证据的小标记：F=判题事实 / K=课程知识 / A=解释与建议（对应 codemind 的证据分离设计） */
export function EvidenceTag({ kind }: { kind: "F" | "K" | "A" }) {
  const map = {
    F: { tone: "neutral" as Tone, text: "判题事实" },
    K: { tone: "brand" as Tone, text: "课程知识" },
    A: { tone: "warn" as Tone, text: "解释与建议" },
  };
  const item = map[kind];
  return (
    <Badge tone={item.tone}>
      {kind}·{item.text}
    </Badge>
  );
}
