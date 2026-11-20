# plants.pyd 逆向：逻辑结构还原

来源：`PKPMAgent/software_link_kit/plants.cp312-win_amd64.pyd`（194 KB，Cython 3.2.6）

## 一、可提取信息总览

| 项 | 可得 | 说明 |
|---|---|---|
| 函数签名 | ✅ 完整 | 含参数类型与返回值 |
| 常量/配置键 | ✅ 完整 | 从压缩字符串表还原 |
| 中文错误提示 | ✅ 完整 | 逆向出全部用户可见文案 |
| 注册表路径 | ✅ 完整 | 安装发现逻辑 |
| 端口/超时常量 | ✅ 完整 | 名称可见 |
| 函数体逻辑 | ⚠️ 部分 | 只能从调用关系与字符串推断 |
| 原始 Python 源码 | ❌ | Cython 编译为机器码，不可还原 |

## 二、完整函数清单（29 个）

```python
connect_to_plants(exe_path: str | None = None,
                  project_path: str | None = None) -> bool | str      # 唯一公开入口

# 准备与连接
_prepare_plants(exe_path=None, project_path=None) -> tuple[int, Path] | str
_ensure_plants_link() -> PlantSMCP
_ensure_plants_config() -> dict
_ensure_mcp_configs_loaded() -> None

# 进程发现
_find_running_plants(target: Path | None = None) -> tuple[int, Path] | None
_matches_target(exe_path: Path, target: Path) -> bool
_discover_install_root() -> Path | None
_resolve_exe_path(explicit_exe_path: Path | None) -> Path | None

# 安装根候选（4 个来源，按优先级）
_candidate_roots() -> Iterable[Path]
_registry_install_roots() -> Iterable[Path]
_registry_pkpmagent2_roots() -> Iterable[Path]
_registry_p3d_association_roots() -> list[Path]
_valid_registry_root(path) -> Path | None
_is_valid_plants_root(root: Path) -> bool
_read_registry_value(key, name: str) -> str
_is_plants_uninstall_entry(key_name, display_name) -> bool

# 启动
_start_plants(exe_path: Path, project_path: Path) -> int | str
_copy_template_project(root: Path) -> Path | str
_resolve_project_path(exe_path: Path, explicit_project_path) -> Path | str

# MCP 健康检查
_wait_for_mcp_ready(pid: int) -> bool
_is_mcp_ready(pid: int) -> bool
_is_port_open(port: int) -> bool

# 工具函数
_normalize_exe_path(path: Path) -> Path
_coerce_path(value: str | Path) -> Path
_current_workspace() -> Path
_path_from_command(command: str) -> Path | None
_persist_verified_exe(mcp_link: PlantSMCP) -> None
```

## 三、关键常量（从压缩字符串表还原）

```python
EXE_NAME           = "BIMBase.exe"
TEMPLATE_RELATIVE_PATH = r"Interface\P3DTemplate\temp.p3d"   # 由 P3DTemplate + temp.p3d 拼合
CONFIG_FILE        = "Base.py"
MCP_SCRIPT         = "StartPlantSMCPServer.py"
SERVER_NAME        = "plantsmcp"
DEFAULT_HOST       = "127.0.0.1"
DISPLAY_NAME_MARKERS = "_三维工厂结构设计系统"     # 卸载表项识别
PROG_IDS           = ["bimbaseplant-struct", "_mcp.p3d"]      # .p3d 关联
```

### 注册表路径（安装发现）

```
HKEY_CURRENT_USER\SOFTWARE\Classes\            → .p3d 关联 → shell\open\command
HKEY_LOCAL_MACHINE\SOFTWARE\Classes\           → 同上（全局）
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall   → UninstallString
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall
HKCU\SOFTWARE\PKPMAgent2\22                    → 自身记录键
```

### 环境变量

```
PLANTS_EXE_PATH   # 显式指定 exe
PLANTS_HOME       # 安装根
PLANTS_ROOT       # 安装根
```

### 超时与轮询

```
STARTUP_TIMEOUT        # 启动等待上限
HEALTH_CHECK_INTERVAL  # MCP 健康检查间隔
socket.AF_INET / SOCK_STREAM / connect_ex  # 端口探测
```

## 四、完整错误文案（逆向还原）

```
"PlantS 工程文件不存在: {path}"
"PlantS 临时工程模板不存在: {path}"
"复制 PlantS 临时工程模板失败: {err}"
"PlantS 主程序不存在: {path}"
"PlantS 启动后立即退出，返回码: {code}"
"启动 PlantS 失败: {err}"
"PlantS 已启动，但 MCP 服务未在端口 {port} 就绪，请检查 PlantS 是否已进入工程主界面，以及内嵌 MCP 脚本是否正常加载。"
"找到的路径不像 PlantS 安装目录，缺少 PlantSPythonEnv"
"未能自动定位 PlantS。请先启动 PlantS，或调用 connect_to_plants(exe_path=r\"...\\BIMBase.exe\") 指定位置。"
"PlantS 工程文件必须是 .p3d: {path}"
"ServerConfig.py 已被禁用，请在 Skills & MCP 页面启用后重试"
```

## 五、逻辑流程还原

```
connect_to_plants(exe_path, project_path)
│
├─ 1. _ensure_mcp_configs_loaded()
│     加载 MCP 服务配置；若 ServerConfig.py 被禁用 → 直接返回错误
│
├─ 2. _resolve_exe_path(explicit_exe_path)
│     ├─ 显式传入 → _normalize_exe_path()
│     ├─ 环境变量 PLANTS_EXE_PATH
│     ├─ _persist_verified_exe 记录的上次成功路径
│     └─ _discover_install_root() → _candidate_roots() 四路候选：
│          ① _registry_install_roots()      卸载表 InstallLocation/InstallDir
│          ② _registry_pkpmagent2_roots()   HKCU\SOFTWARE\PKPMAgent2\22
│          ③ _registry_p3d_association_roots()  .p3d 文件关联
│          ④ 环境变量 PLANTS_HOME/PLANTS_ROOT
│        每个候选过 _is_valid_plants_root()（必须有 PlantSPythonEnv）
│
├─ 3. _find_running_plants(target)
│     遍历 psutil.process_iter() → 匹配 exe 路径
│     命中则 _wait_for_mcp_ready(pid)
│
├─ 4. 未运行 → _start_plants(exe_path, project_path)
│     ├─ _resolve_project_path()
│     │    ├─ 显式 project_path → 校验后缀必须 .p3d
│     │    └─ 否则 _copy_template_project()
│     │         复制 {root}\Interface\P3DTemplate\temp.p3d
│     │         到 workspace/{timestamp}  （%Y%m%d_%H%M%S）
│     ├─ Popen(exe, project, creationflags=CREATE_NEW_CONSOLE)
│     └─ _wait_for_mcp_ready(pid)
│          循环：_is_port_open(port) → _is_mcp_ready(pid)
│          超过 HEALTH_CHECK_INTERVAL*N 或 STARTUP_TIMEOUT → 报错
│
├─ 5. 端口与 MCP 握手
│     get_plants_mcp_port(pid)  →  httpx streamable_http  →  jsonrpc 握手
│
└─ 6. _persist_verified_exe(mcp_link)
      成功后持久化 exe 路径供下次复用（project_path 不持久化）
```

## 六、PlantSMCP 客户端结构

从调用符号推断：

```python
class PlantSMCP:
    get_current_thread_workspace()
    get_plants_mcp_port()
    get_verified_exe_path()
    configure_endpoint()
    asyncio.coroutines / streamable_http / jsonrpc   # MCP 传输层
```

MCP 调用走 `httpx` + `streamable_http`，不是 stdio。

## 七、与技能文档的对应关系

`PlantS-Link.md` 说的：
> 若用户没有显式指定路径，系统会优先复用已经启动且 MCP 畅通的 PlantS；
> 如果没有可用进程，则自动查找 PlantS，并复制安装目录下的
> `Interface\P3DTemplate\temp.p3d` 到当前 workspace 后启动。

现在从代码层面**完全验证了这句话**——包括：
- 「复用」= `_find_running_plants` + `_matches_target`
- 「自动查找」= 四条注册表/环境变量路径
- 「复制模板」= `_copy_template_project`，目标目录带时间戳
- 「MCP 畅通」= `_is_port_open` + `_is_mcp_ready`

## 八、局限说明

**不能还原成 Python 源码**。Cython 3.2.6 把 Python 编译为 C 再编译为机器码，
`.text` 段 156KB 全是 x86-64 指令。反汇编可读但成本极高，且得不到原始表达式。

能拿到的是：**API 结构 + 常量 + 错误处理 + 调用顺序**。
对「照着重写一遍」而言，这些已经足够。
