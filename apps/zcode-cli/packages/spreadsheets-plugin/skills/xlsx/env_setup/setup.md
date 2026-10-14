# XLSX Skill — Environment Setup Guide

This document contains full platform-specific instructions for setting up the XLSX skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

XLSX_SKILL_DIR="<skill_directory>"
export XLSX_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:XLSX_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$XLSX_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:XLSX_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| Runtime | Python 3 + pip | Spreadsheet generation and processing |
| Python pkg | openpyxl | Read/write .xlsx files |
| Python pkg | XlsxWriter | High-performance .xlsx creation |
| Optional render engine | LibreOffice | recalc, .xlsx-to-PDF, .csv-to-.xlsx only — see "LibreOffice (optional render engine)" below |
| Font | CJK fonts (pre-installed in /usr/share/fonts) | Chinese text in spreadsheets |

### Manual Install by Platform

#### macOS

```bash
brew install python3
python3 -m pip install openpyxl XlsxWriter
brew install --cask libreoffice   # optional render engine — only if IT provisions it; see "LibreOffice (optional render engine)" below
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install python3 python3-pip
python3 -m pip install openpyxl XlsxWriter
sudo apt install libreoffice-core   # optional render engine — only if IT provisions it; see "LibreOffice (optional render engine)" below
```

#### Windows (PowerShell)

```powershell
winget install Python.Python.3.11
python -m pip install openpyxl XlsxWriter
winget install TheDocumentFoundation.LibreOffice   # optional render engine — only if IT provisions it; see "LibreOffice (optional render engine)" below
```

Alternative Windows package managers:
- `choco install python3`
- `scoop install python`

> ⚙️ **LibreOffice (optional render engine).** It is needed only for `recalc` (formula
> recalculation), `.xlsx`→PDF, and `.csv`→`.xlsx`. Creating/editing workbooks runs on the bundled
> Python engine and works without it.
>
> If a `recalc`/conversion step is needed and `soffice` is not found:
> 1. **Probe first** — the app injects `ZCODE_LIBREOFFICE_PATH` / `ZCODE_SKILL_ENGINE_ROOT`, and
>    `soffice` may be installed but off-`PATH` (Windows `C:\Program Files\LibreOffice\program\soffice.exe`,
>    macOS `/Applications/LibreOffice.app/Contents/MacOS/soffice`, Linux `/opt/libreoffice*/program/soffice`).
>    If found off-`PATH`, call it by full path or register it — re-verify `soffice --version`.
> 2. **If genuinely absent, route to IT / the intranet.** LibreOffice is provided by the managed
>    base image, an intranet mirror, or a configured engine root. **Do not download from public
>    mirrors** (e.g. the Tsinghua TUNA mirror referenced by the upstream skill) — the network is
>    unreachable.
> 3. **Never silently skip or fake the recalculation.** Do not substitute Excel/WPS/Numbers. If
>    `recalc` is required for delivery and no engine is present, report it as unavailable.
>
> **The gate:** no engine → `recalc`/conversion is reported unavailable, not silently dropped and
> not faked.

---

## Step 3: Font Verification

Fonts are pre-installed in the system font directory `/usr/share/fonts/`.

- **Font base**: `/usr/share/fonts/`
- **Font list**: `env_setup/font_list.txt` (78 fonts, one relative path per line)
- The setup script reads `font_list.txt` and verifies each font exists under `/usr/share/fonts/`

### Font Directory Structure (78 fonts)

| Directory | Count | Description |
|-----------|-------|-------------|
| `truetype/lxgw-wenkai/` | 6 | LXGW WenKai — Chinese handwriting style |
| `truetype/noto-serif-sc/` | 9 | Noto Serif SC — Chinese serif (variable + 8 static weights) |
| `chinese/` | 14 | Noto Sans SC, Sarasa Mono SC, Liberation fallbacks |
| `dejavu/` | 8 | DejaVu Sans/Serif/Mono — Latin/symbol fallback |
| `emoji/` | 1 | Noto Color Emoji |
| `english/` | 12 | Tinos, Carlito, Calibri |
| `freefont/` | 12 | FreeSans/FreeSerif/FreeMono — open-source fallback |
| `liberation/` | 12 | Liberation Sans/Serif/Mono — MS-metric-compatible |
| `libreoffice/` | 1 | OpenSymbol |
| `noto/` | 1 | Noto Color Emoji (duplicate) |
| `wqy/` | 1 | WenQuanYi Zen Hei — CJK fallback |
| *(root)* | 1 | Japanese Gothic |

### Verify Fonts Manually

Check if a font exists:

```bash
ls /usr/share/fonts/truetype/chinese/NotoSansSC\[wght\].ttf
```

Verify all fonts in the list:

```bash
while read f; do
    [ -f "$f" ] && echo "OK: $f" || echo "MISSING: $f"
done < env_setup/font_list.txt
```

### Post-Setup Variable

`FONT_DIR` is set to the system font directory:

| Value | Path |
|-------|------|
| `FONT_DIR` | `/usr/share/fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### pip (Tsinghua mirror)

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  openpyxl XlsxWriter
```

### Windows (PowerShell) China mirrors

```powershell
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn openpyxl XlsxWriter
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Python | https://npmmirror.com/mirrors/python/ |
| LibreOffice | *(not downloaded from public mirrors — provisioned by IT / intranet)* |

---

## LibreOffice (optional render engine) — Intranet provisioning

LibreOffice is **optional** on this deployment. It is needed only for `recalc`, `.xlsx`→PDF, and
`.csv`→`.xlsx`. Creating and editing workbooks run without it.

**Do not download LibreOffice from public mirrors** (e.g. the Tsinghua TUNA mirror referenced by
the upstream skill) — this is an air-gapped deployment and the network is unreachable.

### 1. Probe before concluding it is missing

The app injects `ZCODE_LIBREOFFICE_PATH` / `ZCODE_SKILL_ENGINE_ROOT` when a managed engine
exists, and `soffice` may already be installed but off-`PATH`. Check, in order:

- the injected env vars above;
- the standard install locations — Windows: `C:\Program Files\LibreOffice\program\soffice.exe`;
  macOS: `/Applications/LibreOffice.app/Contents/MacOS/soffice`;
  Linux: `/opt/libreoffice*/program/soffice`;
- `command -v soffice`.

### 2. If it is genuinely absent, route to IT

LibreOffice is provisioned by the managed base image, an intranet mirror, or a configured engine
root. Ask IT to install it into the base image, or point `ZCODE_LIBREOFFICE_PATH` /
`ZCODE_SKILL_ENGINE_ROOT` at an engine the intranet already provides. Do not attempt a public
download.

### 3. Register the binary on PATH (after the engine is present)

A LibreOffice that is installed but whose `soffice` binary is not on the executable search path
is indistinguishable from "not installed" to the next probe. The mechanism differs per OS.

Before anything else, probe (register, do not reinstall, if the binary already exists):

```bash
command -v soffice || ls -d /opt/libreoffice*/program/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null
```

```powershell
Get-Command soffice -ErrorAction SilentlyContinue; Test-Path "C:\Program Files\LibreOffice\program\soffice.exe"
```

#### Linux — symlink into a directory already on `PATH`

```bash
sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice
soffice --version   # re-verify: must print a version, not "command not found"
```

#### macOS — symlink the binary inside the .app bundle

```bash
sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice
soffice --version   # re-verify
```

On Apple Silicon, `/usr/local/bin` is not always on `PATH` — if the verify still fails, link into
`/opt/homebrew/bin` instead: `sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /opt/homebrew/bin/soffice`.

#### Windows — append the program directory to the user `PATH`

```powershell
$LoDir = "C:\Program Files\LibreOffice\program"
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$LoDir*") { setx PATH "$UserPath;$LoDir" }
```

`setx` only affects **newly launched** shells. For the remainder of the current session, call the
binary by its full path: `& "C:\Program Files\LibreOffice\program\soffice.exe" --version`.
