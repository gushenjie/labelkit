/** @type {import('next').NextConfig} */
const fs = require("node:fs");
const path = require("node:path");

const appConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config/app.json"), "utf8"),
);
const { host, apiPort } = appConfig.runtime;
// 0.0.0.0 仅表示监听全网卡，代理回连后端仍走本机
const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const apiOrigin = (process.env.NEXT_PUBLIC_API_URL || `http://${connectHost}:${apiPort}`).replace(/\/$/, "");

const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    // 未显式配置 API 地址时，由 Next 开发服务器代理 /api，消除跨域
    if (process.env.NEXT_PUBLIC_API_URL) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
