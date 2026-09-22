// Reactor 管理台 · HTTP 客户端（T1-2）
// 形态来源：BuildingAI web/http HttpClient（Apache-2.0）——token 注入 / 401 续签重试一次 / 标准错误解析；
// 实现保留 fetch（服务端契约 {error:{message}}，无 axios 必要）。

/**
 * API 基址：
 *  - **开发期恒用 "/api"**：vite 把 `/api` 反代到身份服务 8791。
 *    ⚠️ 不能按 `pathname.startsWith("/console")` 判断 —— T1-3 起控制台就在 `/console/*` 下，
 *    按 pathname 判断会让 dev 一进控制台 BASE 变成空串，所有 API 都打到 vite 自己 → 404
 *   （实测：/console/kb 页面渲染正常但数据全 404，2026-09-19）。
 *  - 生产由服务端在 `/console` 下托管（见 server/src/identity/admin-static.ts），
 *    此时 API 与页面同源、就挂在根路径（/admin/providers、/me …）→ 基址为空。
 * 两种形态共用同一份 dist，无需额外的构建开关。
 */
const BASE = import.meta.env?.DEV
  ? "/api"
  : typeof window !== "undefined" && window.location.pathname.startsWith("/console")
    ? ""
    : "/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenStore {
  getAccess(): string | null;
  getRefresh(): string | null;
  setTokens(access: string, refresh: string): void;
  clearTokens(): void;
}

/** localStorage 实现（与旧 api.ts 键名一致，迁移零成本） */
export const localStorageTokenStore: TokenStore = {
  getAccess: () => localStorage.getItem("reactor.admin.at"),
  getRefresh: () => localStorage.getItem("reactor.admin.rt"),
  setTokens: (a, r) => {
    localStorage.setItem("reactor.admin.at", a);
    localStorage.setItem("reactor.admin.rt", r);
  },
  clearTokens: () => {
    localStorage.removeItem("reactor.admin.at");
    localStorage.removeItem("reactor.admin.rt");
  },
};

export type OnUnauthorized = () => void;

interface ReqOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** 401 时的续签回调（注入以避免 client ↔ 服务层循环依赖） */
  onUnauthorized?: () => Promise<boolean>;
  /** 401 终态回调（清态 + 跳登录） */
  onAuthLost?: () => void;
}

export class HttpClient {
  constructor(private readonly store: TokenStore) {}

  async request<T>(path: string, opts: ReqOpts = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const at = this.store.getAccess();
    if (at) headers.authorization = `Bearer ${at}`;
    const res = await fetch(BASE + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 401 && opts.onUnauthorized && (await opts.onUnauthorized())) {
      return this.request<T>(path, { ...opts, onUnauthorized: undefined });
    }
    // 滑动续签（T3-2）：服务端在 access 临近过期时经 x-new-token 下发新 token
    const renewed = res.headers.get("x-new-token");
    if (renewed) {
      const rt = this.store.getRefresh();
      if (rt) this.store.setTokens(renewed, rt);
    }
    if (res.status === 401) opts.onAuthLost?.();
    if (!res.ok) {
      let message = `请求失败（${res.status}）`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) message = j.error.message;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  get<T>(path: string, opts?: Omit<ReqOpts, "method">): Promise<T> {
    return this.request<T>(path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: Omit<ReqOpts, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...opts, method: "POST", body });
  }
  patch<T>(path: string, body?: unknown, opts?: Omit<ReqOpts, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...opts, method: "PATCH", body });
  }
  put<T>(path: string, body?: unknown, opts?: Omit<ReqOpts, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...opts, method: "PUT", body });
  }
  delete<T>(path: string, opts?: Omit<ReqOpts, "method">): Promise<T> {
    return this.request<T>(path, { ...opts, method: "DELETE" });
  }

  /** 带鉴权下载（CSV 导出等）：返回 Blob，由调用方触发保存。 */
  async download(path: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    const at = this.store.getAccess();
    if (at) headers.authorization = `Bearer ${at}`;
    const res = await fetch(BASE + path, { headers });
    if (!res.ok) throw new ApiError(res.status, `下载失败（${res.status}）`);
    return res.blob();
  }

  /**
   * 原始字节上传（安装包这类几百 MB 的文件）。
   *
   * 为什么不复用 request()：它无条件 `JSON.stringify(body)` 并写死 content-type，
   * 传 File 会变成空对象 `{}`；而且 fetch 拿不到上传进度，大文件上传会变成"点了没反应"。
   * 因此这里用 XHR：只设置 content-type: application/octet-stream，让服务端按原始流落盘，
   * 鉴权头与 x-new-token 续签口径与 request() 保持一致。
   */
  uploadRaw<T>(
    path: string,
    file: Blob,
    opts: {
      headers?: Record<string, string>;
      onProgress?: (progress: UploadProgress) => void;
      onUnauthorized?: () => Promise<boolean>;
      onAuthLost?: () => void;
      /** 内部用：401 续签后只重试一次 */
      retried?: boolean;
    } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", BASE + path);
      const at = this.store.getAccess();
      if (at) xhr.setRequestHeader("authorization", `Bearer ${at}`);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      for (const [key, value] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(key, value);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) opts.onProgress?.({ loaded: event.loaded, total: event.total });
      };

      xhr.onload = () => {
        const renewed = xhr.getResponseHeader("x-new-token");
        if (renewed) {
          const rt = this.store.getRefresh();
          if (rt) this.store.setTokens(renewed, rt);
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(xhr.responseText ? (JSON.parse(xhr.responseText) as T) : (undefined as T));
          } catch {
            reject(new ApiError(xhr.status, "上传响应解析失败"));
          }
          return;
        }
        if (xhr.status === 401) {
          // token 恰好在长上传开始时过期：续签后整包重传一次（此时进度归零，但比报错让人重来强）。
          if (!opts.retried && opts.onUnauthorized) {
            void opts.onUnauthorized().then((ok) => {
              if (!ok) {
                opts.onAuthLost?.();
                reject(new ApiError(401, "登录已失效，请重新登录"));
                return;
              }
              resolve(this.uploadRaw<T>(path, file, { ...opts, retried: true }));
            }, reject);
            return;
          }
          opts.onAuthLost?.();
        }
        let message = `上传失败（${xhr.status}）`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          /* 非 JSON 响应（网关/代理错误页）时保留默认文案 */
        }
        reject(new ApiError(xhr.status, message));
      };
      xhr.onerror = () => reject(new ApiError(0, "上传中断（网络错误）"));
      xhr.send(file);
    });
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export const http = new HttpClient(localStorageTokenStore);
