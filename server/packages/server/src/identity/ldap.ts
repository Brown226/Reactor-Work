/**
 * LDAP 客户端（第 1 批）：镜像公司口径——服务账号在 BaseDN(OU=cnpe,DC=cnpe,DC=cc)
 * 下按登录属性搜得用户 DN，再以用户 DN+密码 bind 校验（对应参考 C# 的 ADValid）。
 * mock OpenLDAP 用 loginAttr=uid；真实 AD 切 sAMAccountName 即可（config）。
 */

import * as ldapjsNs from "ldapjs";

// ldapjs 为 CommonJS 且模块导出未被 cjs-lexer 识别为具名导出：
// ESM `import * as` 命名空间里 createClient 会变 undefined。取 default(=module.exports) 回退。
const ldap: typeof ldapjsNs = (ldapjsNs as unknown as { default?: typeof ldapjsNs }).default ?? ldapjsNs;
type LdapClient = ldapjsNs.Client;
type LdapSearchResponse = ldapjsNs.SearchCallbackResponse;
type LdapSearchError = ldapjsNs.Error | null;

export interface LdapSettings {
  url: string;
  baseDn: string;
  adminDn: string;
  adminPwd: string;
  loginAttr: string;
}

export interface LdapUser {
  uid: string;
  name: string;
  email: string | null;
  dn: string;
  /** 部门路径（root→leaf，不含 ou=cnpe），由 DN 的 OU 段解析 */
  ouPath: string[];
}

interface LdapEntryLike {
  object?: Record<string, unknown>;
  attributes?: Array<{ type: string; values: unknown[] }>;
}

function strOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return String(v);
}

/** 从 ldapjs SearchEntry 读属性：优先 attributes[]，回退 object（ldapjs 实际不填充 object）。 */
function entryStr(entry: LdapEntryLike, attr: string): string | null {
  const lower = attr.toLowerCase();
  for (const a of entry.attributes ?? []) {
    if (a.type.toLowerCase() === lower) return strOf(a.values);
  }
  const obj = entry.object;
  if (obj) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lower) return strOf(obj[key]);
    }
  }
  return null;
}

function escapeFilter(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (ch) => (ch === "\u0000" ? "\\00" : `\\${ch}`));
}

/** 按未转义逗号拆分 DN 的 RDN 段（本域数据无逗号转义需求，仍做最小处理）。 */
function splitRdns(head: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let esc = false;
  for (const ch of head) {
    if (esc) {
      cur += ch;
      esc = false;
    } else if (ch === "\\") {
      esc = true;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** 解码 DN 中的 RFC4514 \XX 十六进制转义（中文 OU 以 UTF-8 字节转义，如 \e5\88\86）。 */
function decodeHexEscapes(value: string): string {
  const out: string[] = [];
  let bytes: number[] = [];
  let i = 0;
  const flush = (): void => {
    if (bytes.length) {
      out.push(Buffer.from(bytes).toString("utf8"));
      bytes = [];
    }
  };
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === "\\" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      flush();
      out.push(ch);
      i += 1;
    }
  }
  flush();
  return out.join("");
}

function dnToString(dn: unknown): string {
  if (typeof dn === "string") return dn;
  if (dn && typeof (dn as { toString: () => string }).toString === "function") {
    return (dn as { toString: () => string }).toString();
  }
  return String(dn);
}

/** 由用户 DN 与 BaseDN 还原部门路径（root→leaf）。解析失败返回 null。 */
export function ouPathFromDn(dnValue: unknown, baseDn: string): string[] | null {
  const dn = dnToString(dnValue);
  if (dn.toLowerCase() === baseDn.toLowerCase()) return [];
  if (!dn.toLowerCase().endsWith(baseDn.toLowerCase())) return null;
  const head = dn.slice(0, dn.length - baseDn.length).replace(/,\s*$/, "");
  const ous: string[] = [];
  for (const rdn of splitRdns(head)) {
    const eq = rdn.indexOf("=");
    if (eq <= 0) continue;
    const attr = rdn.slice(0, eq).trim().toLowerCase();
    if (attr === "ou") ous.push(decodeHexEscapes(rdn.slice(eq + 1)).trim());
  }
  return ous.reverse();
}

async function withClient<T>(url: string, fn: (c: LdapClient) => Promise<T>): Promise<T> {
  const client = ldap.createClient({ url, reconnect: false });
  /**
   * ⚠ 必须挂 `error` 监听器，否则**整个 identity 进程会被杀掉**。
   *
   * 事故复盘（2026-09-19 实测）：ldapjs 的 Client 是 EventEmitter，连接失败（Docker 停着
   * → 1389 端口不存在，ECONNREFUSED）时它 emit('error')；无人监听 → Node 抛
   * `Unhandled 'error' event` → 进程直接退出。表现为：identity 启动了、/health 通了一会儿、
   * 用户一登录（登录才碰 LDAP）就整进程消失，之后所有请求都是 `fetch failed`，
   * 而日志里只有一行 ECONNREFUSED，看不出"进程已死"。
   *
   * 语义：连接级错误**挂起即可**——真正的失败由 `bind/search` 回调的 err 上抛（调用方已按
   * "错密码=49 / 网络错误上抛"区分处理）。这里只负责不让它变成未捕获异常。
   */
  const swallowed: Error[] = [];
  client.on("error", (err: Error) => { swallowed.push(err); });
  try {
    return await fn(client);
  } catch (err) {
    // 若业务抛出的是空/泛化错误，而连接层已有更具体的原因，用连接层原因替换（便于定位）
    if (swallowed.length > 0 && (!err || (err as Error).message === "")) throw swallowed[0];
    throw err;
  } finally {
    try {
      client.unbind(() => undefined);
    } catch {
      /* ignore */
    }
    client.destroy();
  }
}

function bind(client: LdapClient, dn: string, pwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, pwd, (err: unknown) => (err ? reject(err) : resolve()));
  });
}

/** 服务账号 bind 后执行 sub 搜索，返回规范化用户列表。 */
function searchUsers(
  settings: LdapSettings,
  filter: string,
): Promise<LdapUser[]> {
  return withClient(settings.url, async (client) => {
    await bind(client, settings.adminDn, settings.adminPwd);
    const users: LdapUser[] = [];
    await new Promise<void>((resolve, reject) => {
      client.search(
        settings.baseDn,
        { scope: "sub", filter, attributes: [settings.loginAttr, "uid", "displayName", "cn", "mail"] },
        (err: LdapSearchError, res: LdapSearchResponse) => {
          if (err) return reject(err);
          res.on("searchEntry", (raw: unknown) => {
            const entry = raw as LdapEntryLike & { dn: unknown };
            const uid = entryStr(entry, settings.loginAttr) ?? entryStr(entry, "uid");
            const dn = dnToString(entry.dn);
            const name = entryStr(entry, "displayName") ?? entryStr(entry, "cn") ?? uid;
            const mail = entryStr(entry, "mail");
            if (!uid) return;
            const ouPath = ouPathFromDn(dn, settings.baseDn);
            if (!ouPath) return; // 不在 BaseDN 内（异常数据），跳过
            users.push({ uid, name: name ?? uid, email: mail, dn, ouPath });
          });
          res.on("error", reject);
          res.on("end", () => resolve());
        },
      );
    });
    return users;
  });
}

/** 全量枚举（同步用）：BaseDN 下所有 inetOrgPerson。 */
export function listLdapUsers(settings: LdapSettings): Promise<LdapUser[]> {
  return searchUsers(settings, "(objectClass=inetOrgPerson)");
}

/** 按登录属性查单个用户（登录用）。 */
export async function findLdapUserByLogin(settings: LdapSettings, login: string): Promise<LdapUser | null> {
  const filter = `(&(objectClass=inetOrgPerson)(${settings.loginAttr}=${escapeFilter(login)}))`;
  const users = await searchUsers(settings, filter);
  return users[0] ?? null;
}

/** 以用户 DN + 密码 bind（对应 ADValid）。错密码=LDAP 49 → false；网络/服务错误上抛。 */
export async function verifyUserBind(settings: LdapSettings, userDn: string, password: string): Promise<boolean> {
  return withClient(settings.url, async (client) => {
    try {
      await bind(client, userDn, password);
      return true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 49 || code === 53) return false; // invalidCredentials / unwillingToPerform
      throw err;
    }
  });
}
