import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
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
