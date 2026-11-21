# 工程软件对接的实机验证清单

本清单用于在真实 Windows 环境确认 BKBM 工程连接层可用。容器内无法验证
的项目全部列在这里，逐项记录结论后再决定下一步。

模块位置：`packages/services/src/engineering/`

## 一、必验项（阻塞后续开发）

### 1. MCP 端口反查

- **现状**：`bimbase.ts` 的 `readMcpPortForPid` 返回 `undefined`，端口通过
  `setPortResolver` 注入。
- **为什么没实现**：端口由软件启动时写入自身配置，文件格式与位置随版本
  变化，没有实机无法确定。
- **怎么验**：
  1. 手动启动 BIMBase，打开一个工程。
  2. 排查软件写到哪个文件：常见位置是安装目录下的配置文件、
     `%LOCALAPPDATA%\<产品>\`、或工程目录旁的 `*.ini`/`*.json`。
  3. 确认端口后，用 `setPortResolver` 注入一个读该文件的函数即可。
- **判据**：`connect('bimbase')` 返回 `true` 且简报里有函数类别。

### 2. 模板工程路径

- **现状**：`bimbase.ts` 按 `PlantSPythonEnv/../Interface/P3DTemplate/temp.p3d`
  推导，失败时退让为「用工作目录」。
- **怎么验**：确认安装目录下模板工程的真实相对路径。
- **判据**：日志里不出现「模板缺失」的回退。

### 3. 激活码与授权

- **现状**：启动流程假定软件已被授权。
- **怎么验**：确认未激活时启动的行为（是弹窗、报错退出、还是能开只读）。
- **判据**：未激活时连接层能给出可读错误，而不是卡在等端口。

## 二、需要确认的行为

### 4. 进程复用是否安全

- **现状**：`findProcessesByExecutable` 按可执行文件名匹配，Windows 走
  CIM，POSIX 走 `ps`（只能拿到 basename，注释里已标注限制）。
- **要确认**：同名的两个安装实例（如两个版本）会不会被认错。
- **判据**：多版本共存时能选到正确的那一个，或明确要求用户指定 `exePath`。

### 5. COM 系软件的 Dispatch 前置条件

- **现状**：`com-software.ts` 只检查可执行文件存在，不做 Dispatch。
- **要确认**：SAP2000 / ETABS / AutoCAD / Rhino 是否需要先登录、是否有
  COM 注册表登记、32/64 位是否匹配。
- **判据**：Python 侧 `win32com.client.Dispatch` 能成功拿到对象。

### 6. 文件桥接的权限与并发

- **现状**：桥接目录在 `tmpdir()` 下，按 key 哈希命名。
- **要确认**：企业环境下 temp 目录是否可写、是否被杀毒软件拦截。
- **判据**：脚本执行期间 `.req.json` 与 `.res.json` 能正常交换。

## 三、验证方法

每一步都用最小脚本确认，不要一次跑完整流程：

```ts
import { EngineeringExecutor } from "@zcode/services";

const executor = new EngineeringExecutor({ interpreter: "python" });

// 1. 只验连接
const connected = await executor.connect("bimbase", {
  exePath: "D:/BIMBase/BIMBase.exe",
});
console.log("连接:", connected);
if (connected === true) {
  // 2. 只验能力清单
  console.log("简报:", executor.briefing("bimbase").slice(0, 500));

  // 3. 只验一个只读函数
  const r = await executor.run({
    server: "bimbase",
    code: 'print(function_search(action="GetType"))',
  });
  console.log("检索:", r.ok, r.stdout, r.error);
}
```

## 四、已知限制（不需要验）

| 限制 | 说明 |
| --- | --- |
| POSIX 上只能按 basename 匹配进程 | `ps` 的 `comm` 不含目录；Windows 上是完整路径 |
| 无会话时注入桩会抛错 | 这是正确行为：COM 系由技能脚本自己 Dispatch |
| 摘要为兜底文本 | 未接摘要模型，只如实说明压掉了多少条 |

## 五、验证记录

逐项填结论，作为后续开发的输入：

| # | 项目 | 结论 | 日期 |
| --- | --- | --- | --- |
| 1 | MCP 端口反查 | 待验 | |
| 2 | 模板工程路径 | 待验 | |
| 3 | 激活码行为 | 待验 | |
| 4 | 多版本进程识别 | 待验 | |
| 5 | COM Dispatch 前置条件 | 待验 | |
| 6 | temp 目录可写性 | 待验 | |
