import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--lk-font-sans)"],
        mono: ["var(--lk-font-mono)"],
      },
      fontSize: {
        "page-title": ["var(--lk-type-page-title-size)", { lineHeight: "var(--lk-type-page-title-line)" }],
        "compact-title": ["var(--lk-type-compact-title-size)", { lineHeight: "var(--lk-type-compact-title-line)" }],
        "section-title": ["var(--lk-type-section-title-size)", { lineHeight: "var(--lk-type-section-title-line)" }],
        metric: ["var(--lk-type-metric-size)", { lineHeight: "var(--lk-type-metric-line)" }],
        body: ["var(--lk-type-body-size)", { lineHeight: "var(--lk-type-body-line)" }],
        "body-sm": ["var(--lk-type-body-sm-size)", { lineHeight: "var(--lk-type-body-sm-line)" }],
        label: ["var(--lk-type-label-size)", { lineHeight: "var(--lk-type-label-line)" }],
        caption: ["var(--lk-type-caption-size)", { lineHeight: "var(--lk-type-caption-line)" }],
        micro: ["var(--lk-type-micro-size)", { lineHeight: "var(--lk-type-micro-line)" }],
      },
      colors: {
        brand: {
          50: "#ecfdf8",
          100: "#d1faed",
          500: "#12a88f",
          600: "#07947d",
          700: "#087866",
        },
        ink: "#101828",
        text: "#344054",
        muted: "#667085",
        subtle: "#98a2b3",
        border: "#e4e7ec",
        surface: {
          DEFAULT: "#ffffff",
          soft: "#f7f9fb",
        },
        canvas: "#f8fafb",
        success: {
          50: "#ecfdf3",
          600: "#079455",
        },
        warning: {
          50: "#fffaeb",
          600: "#dc6803",
        },
        danger: {
          50: "#fef3f2",
          600: "#d92d20",
        },
      },
      boxShadow: {
        panel: "0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 20px rgba(16, 24, 40, 0.035)",
      },
    },
  },
  plugins: [],
};
export default config;
