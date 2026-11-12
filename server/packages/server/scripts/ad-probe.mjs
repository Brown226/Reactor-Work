/**
 * 真实 AD 联调探针（内网部署用）。
 *
 * 为什么需要它：目标 Linux 服务器上通常没有 `ldapsearch`，而 AD 联调的失败点
 * （网络不通 / 服务账号口令错 / filter 写错搜不到人 / 域控要求签名）各有不同的
 * 表象，靠"登录试试"只能看到一句「用户名或密码错误」，无法定位。这个脚本把
 * 每一步拆开，逐项报告成功/失败与具体 LDAP 错误码。
 *
 * 用法（在 compose 所在目录）：
 *   # 只探测连通 + 服务账号 bind + 能搜到多少人（不碰任何用户密码）
 *   docker compose exec identity node scripts/ad-probe.mjs
 *
 *   # 追加一次真实用户 bind 校验（账号口令走命令行，不落盘、不进日志）
 *   docker compose exec identity node scripts/ad-probe.mjs <登录账号> <密码>
 *
 * 退出码：0=全部通过；1=有步骤失败（报告里会指出哪一步）。
 */

import * as ldapjsNs from "ldapjs";

const ldap = ldapjsNs.default ?? ldapjsNs;

/** LDAP 结果码 → 人话。只列联调真会碰到的。 */
const CODE_TEXT = {
  1: "操作错误（服务端内部错误）",
  32: "找不到对象（DN 不存在，检查 REACTOR_LDAP_BASE_DN / ADMIN_DN）",
  34: "DN 语法无效",
  48: "不支持的认证机制",
  49: "凭据无效（口令错，或账号被禁用）",
  50: "权限不足（服务账号无权在该 BaseDN 下搜索）",
  51: "服务端繁忙",
  52: "AD 不可用（通常是域控未就绪或网络层断开）",
  53: "服务端不愿意执行（常见于明文 bind 被域控签名策略拒绝）",
  80: "未知错误",
  81: "无法联系 LDAP 服务（网络不通/端口错/防火墙）",
};

/** ldapjs 的错误里，code 可能挂在 err.code / err.lde_code / err.name。 */
function codeOf(err) {
  return err?.code ?? err?.lde_code ?? err?.ldapCode ?? null;
}

function describeErr(err) {
  const code = codeOf(err);
  const text = code !== null ? CODE_TEXT[code] : null;
  const msg = err?.message ?? String(err);
  if (code !== null) return `LDAP 错误码 ${code}${text ? `（${text}）` : ""} — ${msg}`;
  // 连接层错误没有 code，用 errno/cause 描述
  const cause = err?.cause?.code ?? err?.code;
  return `${cause ? `[${cause}] ` : ""}${msg}`;
}

function maskDn(dn) {
  return typeof dn === "string" ? dn : String(dn);
}

async function step(name, fn) {
  process.stdout.write(`\n▸ ${name} ... `);
  try {
    const out = await fn();
    process.stdout.write("✅\n");
    return { ok: true, out };
  } catch (err) {
    process.stdout.write("❌\n");
    console.log(`    ${describeErr(err)}`);
    return { ok: false, err };
  }
}

function withClient(url, fn) {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url, reconnect: false });
    // 必须挂 error 监听：ldapjs 连接失败会 emit('error')，无人监听会把整个进程杀掉
    // （identity 里同一处有事故复盘注释）。
    const swallowed = [];
    client.on("error", (e) => swallowed.push(e));
    Promise.resolve()
      .then(() => fn(client))
      .then(resolve, (err) => {
        if (swallowed.length && (!err || !err.message)) reject(swallowed[0]);
        else reject(err);
      })
      .finally(() => {
        try {
          client.unbind(() => undefined);
        } catch {
          /* ignore */
        }
        client.destroy();
      });
  });
}

const cfg = {
  url: process.env.REACTOR_LDAP_URL ?? "ldap://127.0.0.1:1389",
  baseDn: process.env.REACTOR_LDAP_BASE_DN ?? "ou=cnpe,dc=cnpe,dc=cc",
  adminDn: process.env.REACTOR_LDAP_ADMIN_DN ?? "cn=admin,dc=cnpe,dc=cc",
  // 口令**不设兜底**：未注入时明确失败。反例是静默用 mock 口令去 bind 真实 AD，
  // 会把「没读到配置」误报成「AD 口令错」，把排查引向错误方向。
  // （AGENTS.md：不在脚本中写凭据。）
  adminPwd: process.env.REACTOR_LDAP_ADMIN_PWD,
  loginAttr: process.env.REACTOR_LDAP_LOGIN_ATTR ?? "uid",
  userFilter: process.env.REACTOR_LDAP_USER_FILTER ?? "(objectClass=inetOrgPerson)",
};

const [testLogin, testPwd] = process.argv.slice(2);

// 前置校验：口令缺失时直接收尾，不做无意义的连接尝试
if (!cfg.adminPwd) {
  console.log("═".repeat(64));
  console.log("❌ 未读到 REACTOR_LDAP_ADMIN_PWD（LDAP 服务账号口令）。");
  console.log("═".repeat(64));
  console.log("  它由 .env 提供、经 compose 注入 identity 容器。请检查：");
  console.log("   ① server/.env 里 REACTOR_LDAP_ADMIN_PWD 是否非空（已 gitignore，不进镜像）");
  console.log("   ② 若刚改过 .env，需重启 identity 容器：docker compose up -d identity");
  console.log("   ③ 手动指定：docker compose exec -e REACTOR_LDAP_ADMIN_PWD='***' identity \\");
  console.log("        node scripts/ad-probe.mjs");
  console.log("═".repeat(64));
  process.exit(1);
}

console.log("═".repeat(64));
console.log("Reactor AD/LDAP 联调探针");
console.log("═".repeat(64));
console.log(`  目标        : ${cfg.url}`);
console.log(`  BaseDN      : ${cfg.baseDn}`);
console.log(`  服务账号    : ${cfg.adminDn}`);
console.log(`  登录属性    : ${cfg.loginAttr}`);
console.log(`  用户 filter : ${cfg.userFilter}`);
console.log(`  口令        : 已配置（不显示）`);

const results = [];

// ── 1. 连通 + 服务账号 bind ──────────────────────────────────────────────
results.push(
  await step("连接 AD 并以服务账号 bind", () =>
    withClient(cfg.url, (client) =>
      new Promise((resolve, reject) => {
        client.bind(cfg.adminDn, cfg.adminPwd, (err) =>
          err ? reject(err) : resolve("bind 成功"),
        );
      }),
    ),
  ),
);

// 服务账号 bind 失败时，后面两步都没有意义（搜索同样会失败），直接收尾
if (!results[0].ok) {
  console.log("\n" + "═".repeat(64));
  console.log("结论：服务账号 bind 失败，后续步骤跳过。");
  console.log("排查顺序：① 网络/端口 → ② 服务账号 DN 是否写错 → ③ 口令 → ④ 域控签名策略");
  console.log("═".repeat(64));
  process.exit(1);
}

// ── 2. 按 filter 搜索，统计能拿到多少用户 ────────────────────────────────
let sampleUsers = [];
results.push(
  await step(`按 filter 搜索用户（scope=sub）`, () =>
    withClient(cfg.url, async (client) => {
      await new Promise((resolve, reject) =>
        client.bind(cfg.adminDn, cfg.adminPwd, (err) => (err ? reject(err) : resolve())),
      );
      const found = [];
      await new Promise((resolve, reject) => {
        client.search(
          cfg.baseDn,
          {
            scope: "sub",
            filter: cfg.userFilter,
            // 只请求真实存在的属性：loginAttr 已在数组内（AD=sAMAccountName），
            // 不另写死 uid——AD 没有该属性。
            attributes: [cfg.loginAttr, "displayName", "cn", "mail"],
            sizeLimit: 5000,
          },
          (err, res) => {
            if (err) return reject(err);
            res.on("searchEntry", (raw) => {
              const attrs = raw.attributes ?? [];
              const pick = (n) => {
                const a = attrs.find((x) => x.type.toLowerCase() === n.toLowerCase());
                return a && a.values.length ? String(a.values[0]) : null;
              };
              found.push({
                login: pick(cfg.loginAttr),
                name: pick("displayName") ?? pick("cn"),
                mail: pick("mail"),
                dn: maskDn(raw.dn),
              });
            });
            res.on("error", reject);
            res.on("end", () => resolve());
          },
        );
      });
      sampleUsers = found;
      return found;
    }),
  ),
);

const searchOk = results[1].ok;
if (searchOk) {
  const n = sampleUsers.length;
  console.log(`    命中用户数：${n}`);
  if (n === 0) {
    console.log("    ⚠ 0 人——搜索成功了但没匹配到任何用户，这是「filter 写错」的典型表现。");
    console.log(`       AD 的用户对象是 objectClass=user（不是 mock 的 inetOrgPerson）。`);
    console.log(`       试这个：`);
    console.log(`       (&(objectClass=user)(objectCategory=person)!(userAccountControl:1.2.840.113556.1.4.803:=2))`);
  } else {
    console.log("    抽样（前 3 条，用于核对部门 DN 与显示名）：");
    for (const u of sampleUsers.slice(0, 3)) {
      console.log(`      - ${u.login} | ${u.name ?? "(无显示名)"} | ${u.mail ?? "(无邮箱)"}`);
      console.log(`        ${u.dn}`);
    }
  }
}

// ── 3. 可选：真实用户 bind 校验 ──────────────────────────────────────────
if (testLogin && testPwd) {
  results.push(
    await step(`以测试账号「${testLogin}」bind 校验`, () =>
      withClient(cfg.url, async (client) => {
        // 先按登录属性搜 DN
        const esc = testLogin.replace(/[\\*() ]/g, (c) => `\\${c}`);
        const filter = `(&${cfg.userFilter}(${cfg.loginAttr}=${esc}))`;
        const dns = [];
        await new Promise((resolve, reject) => {
          client.bind(cfg.adminDn, cfg.adminPwd, (err) => (err ? reject(err) : resolve()));
          client.search(cfg.baseDn, { scope: "sub", filter, attributes: [cfg.loginAttr] }, (err, res) => {
            if (err) return reject(err);
            res.on("searchEntry", (raw) => dns.push(maskDn(raw.dn)));
            res.on("error", reject);
            res.on("end", () => resolve());
          });
        });
        if (!dns.length) {
          throw new Error(`按 ${cfg.loginAttr}=${testLogin} 没搜到用户（filter 或账号名不对）`);
        }
        // 再用用户 DN + 用户输入的密码 bind（= 登录链路的真实判定）
        await new Promise((resolve, reject) => {
          client.bind(dns[0], testPwd, (err) => (err ? reject(err) : resolve()));
        });
        return `bind 成功：${dns[0]}`;
      }),
    ),
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok).length;
console.log("\n" + "═".repeat(64));
if (failed === 0) {
  console.log(`结论：${results.length}/${results.length} 项全部通过。`);
  console.log("接下来：管理台 → 组织与权限 → 组织同步 → 先点「预览」看差异，再「执行同步」。");
} else {
  console.log(`结论：${failed} 项失败，共 ${results.length} 项。`);
}
console.log("═".repeat(64));
process.exit(failed === 0 ? 0 : 1);
