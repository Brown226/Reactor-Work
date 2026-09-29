# Linux / WSL 排查

本页针对 Linux 桌面端与 WSL 环境下启动、登录回调、中文输入法几类高频问题。桌面端在 macOS、Windows、Linux 三平台共用同一套渲染与 Agent 运行时，差异集中在**系统集成**部分。

## 1. 推荐使用方式

| 建议 | 原因 |
| --- | --- |
| 用普通用户启动，**不要 `sudo`** | 以 root 启动会让新建文件归 root，后续普通用户无法编辑 |
| 安装包只选一种（deb 或 AppImage） | 混装会互相覆盖系统关联，导致打开方式不一致 |
| AppImage 放在固定路径（如 `~/Applications/`） | 移动或改名会让登录回调与 desktops 关联失效 |
| WSLg 下在**同一环境内**启动 Reactor 与浏览器 | 跨环境会破坏登录回调的协议关联 |
| 中文输入法用系统已配置好的输入法框架 | 直接用系统框架比在应用内模拟稳定 |

> **提示**：本页命令为 Linux 环境通用写法。在 WSL 下执行前请确认处于目标发行版内。

## 2. AppImage 无法启动

### 缺少 `libfuse.so.2`

AppImage 依赖 FUSE 2 兼容库。Debian / Ubuntu 系：

```bash
sudo apt update
sudo apt install libfuse2
```

部分发行版的仓库不再提供 `libfuse2`，需安装 FUSE 2 兼容包后再试。

### 已经 `chmod +x` 仍无反应

依次确认：

```bash
# 1. 文件确实可执行
ls -l ~/Applications/Reactor.AppImage

# 2. 直接在终端运行，看真实报错
~/Applications/Reactor.AppImage

# 3. 若为显示相关报错，临时绕开 GPU 加速
~/Applications/Reactor.AppImage --disable-gpu --disable-software-rasterizer --use-gl=swiftshader
```

> **提示**：`--no-sandbox` **只建议用于定位问题或临时绕过**，不要作为长期使用方式；长期使用优先安装 deb 版。

### 建议的放置方式

```bash
mkdir -p ~/Applications
mv Reactor-*.AppImage ~/Applications/Reactor.AppImage
chmod +x ~/Applications/Reactor.AppImage
```

固定路径后再建立桌面关联；**登录前后不要移动该文件**。

## 3. 登录后没有回到应用

### 先判断是否以 root 运行

```bash
id -u        # 输出 0 表示 root，需要换回普通用户
```

### 检查协议关联

```bash
xdg-mime query default x-scheme-handler/zcode
```

正常情况下应输出类似 `zcode.desktop`。若为空或指向旧版本，说明关联被覆盖或丢失。

常见诱因：

| 诱因 | 处理 |
| --- | --- |
| AppImage 被移动、改名或删除 | 移回固定路径，重新建立关联 |
| deb 与 AppImage 混装 | 只保留一种安装方式，清理另一种 |
| 曾用 `sudo` 启动 | 修复用户目录权限后改用普通用户启动 |
| 系统关联到旧版本客户端 | 重新执行关联设置，指向当前客户端 |
| 启动参数与系统打开方式不一致 | 统一从桌面图标或同一路径启动 |

检查 desktop 文件里的 `Exec=` 是否指向**当前**客户端路径：

```bash
grep -H '^Exec=' ~/.local/share/applications/*.desktop
```

## 4. 中文输入法无法使用

先用环境变量与输入法状态判断当前框架：

```bash
echo "$GTK_IM_MODULE / $QT_IM_MODULE / $XMODIFIERS"
ibus engine          # IBus 环境
fcitx5-remote        # Fcitx5 环境
```

### IBus

```bash
ibus-daemon -drx
```

启动应用时确保输入法模块生效：

```bash
GTK_IM_MODULE=ibus QT_IM_MODULE=ibus XMODIFIERS=@im=ibus ~/Applications/Reactor.AppImage
```

### Fcitx5

```bash
fcitx5 -d
```

```bash
GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx XMODIFIERS=@im=fcitx ~/Applications/Reactor.AppImage
```

> **提示**：把输入法环境变量写进 shell 启动配置，再从该 shell 启动应用，比每次手动指定更稳定。

### WSLg 下首个中文字符不显示

WSLg 有已知兼容问题：首次切换中文时，第一个字符不会立即出现，需要先输入一个英文字符或占位字符再删除。可尝试：

1. 从已配置输入法环境变量的 shell 启动应用。
2. 切换到 Fcitx5。

## 5. 反馈问题时请附上这些信息

```bash
echo "$WSL_DISTRO_NAME"
echo "$XDG_SESSION_TYPE"
echo "$DISPLAY"
echo "$WAYLAND_DISPLAY"
echo "$BROWSER"
id -u
which xdg-open xdg-mime
grep -H '^Exec=' ~/.local/share/applications/*.desktop
ls -l ~/Applications/Reactor.AppImage
```

再补充输入法环境变量与状态（`GTK_IM_MODULE` / `QT_IM_MODULE` / `XMODIFIERS`，以及 `ibus engine` 或 `fcitx5-remote` 的输出）。

> **提示**：提交日志或配置片段前请先脱敏，**不要**附上凭据、令牌或真实内网地址。

## 6. 与上游 ZCode 的差异

| 项 | 上游写法 | 本说明书写法 | 原因 |
| --- | --- | --- | --- |
| 应用名与路径 | `ZCode.app`、`ZCode-*.AppImage`、`x-scheme-handler/zcode` | 应用名改为 Reactor / `Reactor.AppImage`，协议关联沿用 `zcode` | 协议名属系统关联标识，本仓未改动；其余按本仓产品名替换 |
| 安装包来源 | 指向官网下载页与各平台安装包外链 | 删除下载外链，只保留本机排查命令 | 内网隔离部署不提供公网下载 |
| 排查命令 | 与本文一致 | 保留，并补充"反馈时请提供的信息" | 页面自述需提供诊断信息，本仓同样需要 |
