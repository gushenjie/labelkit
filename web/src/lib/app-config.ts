import appDefaults from "../../../config/app.json";

const versionParts = appDefaults.brand.version.split(".");

export const BRAND = {
  department: appDefaults.brand.department,
  productName: appDefaults.brand.productName,
  fullName: appDefaults.brand.fullName,
  tagline: appDefaults.brand.tagline,
  slogan: appDefaults.brand.slogan,
  edition: appDefaults.brand.edition,
  version: appDefaults.brand.version,
  versionLabel: `v${versionParts[0]}.${versionParts[1]}`,
} as const;

/** 监听地址为 0.0.0.0 时，进程内回连仍用本机回环 */
function connectHost(bindHost: string): string {
  return bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
}

const bindHost = appDefaults.runtime.host;
const localHost = connectHost(bindHost);

export const RUNTIME = {
  host: bindHost,
  localHost,
  apiPort: appDefaults.runtime.apiPort,
  webPort: appDefaults.runtime.webPort,
  apiOrigin: `http://${localHost}:${appDefaults.runtime.apiPort}`,
  webOrigin: `http://${localHost}:${appDefaults.runtime.webPort}`,
} as const;

export const brandPageTitle = BRAND.fullName;

export const brandHomeLabel = `${BRAND.fullName}首页`;

export const brandVersionLabel = `${BRAND.fullName} ${BRAND.versionLabel}`;
