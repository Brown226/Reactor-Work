declare module "*.css";
declare module "*.mp3";
declare module "*.jpg";
declare module "*.png";
declare module "*.svg";
declare module "*.webp";

// Vite 的 `?url` 资源导入（如 pdf.js worker），返回打包后的资源 URL 字符串。
declare module "*?url" {
  const src: string;
  export default src;
}

// Vite 的 `?worker&url` 导入：经 worker 插件打包后返回可用的 worker URL 字符串。
declare module "*?worker&url" {
  const src: string;
  export default src;
}
