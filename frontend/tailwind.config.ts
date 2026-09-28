import type { Config } from "tailwindcss";

/** Unified visual tokens for the teaching platform. */
const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: token("--brand"),
          fg: token("--brand-fg"),
          soft: token("--brand-soft"),
        },
        surface: {
          DEFAULT: token("--surface"),
          raised: token("--surface-raised"),
          muted: token("--surface-muted"),
        },
        line: {
          DEFAULT: token("--border"),
          strong: token("--border-strong"),
        },
        fg: {
          DEFAULT: token("--fg"),
          muted: token("--fg-muted"),
          subtle: token("--fg-subtle"),
        },
        ok: { DEFAULT: token("--ok"), soft: token("--ok-soft") },
        warn: { DEFAULT: token("--warn"), soft: token("--warn-soft") },
        danger: { DEFAULT: token("--danger"), soft: token("--danger-soft") },
        chart: {
          1: token("--chart-1"),
          2: token("--chart-2"),
          3: token("--chart-3"),
          4: token("--chart-4"),
        },
      },
      borderRadius: {
        card: "var(--radius-card)",
        control: "var(--radius-control)",
        pill: "var(--radius-control)",
      },
      spacing: {
        card: "var(--pad-card)",
        stack: "var(--gap-stack)",
        inline: "var(--gap-inline)",
      },
      fontSize: {
        display: ["var(--fs-display)", { lineHeight: "1.25" }],
        title: ["var(--fs-title)", { lineHeight: "1.3" }],
        body: ["var(--fs-body)", { lineHeight: "var(--lh-body)" }],
        meta: ["var(--fs-meta)", { lineHeight: "1.45" }],
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [],
} satisfies Config;
