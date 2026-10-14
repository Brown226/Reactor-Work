# PDF Skill — Environment Setup Guide

This document contains full platform-specific instructions for setting up the PDF skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

PDF_SKILL_DIR="<skill_directory>"
export PDF_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:PDF_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$PDF_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:PDF_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| **Core** Runtime | Python 3 + pip | PDF generation and processing |
| **Core** Python pkg | reportlab | Report/cover pipeline PDF generation |
| **Core** Python pkg | pypdf | PDF reading/writing/merge |
| **Core** Python pkg | PyMuPDF (fitz) | Fast PDF rendering and extraction |
| **Core** Python pkg | pikepdf | PDF manipulation (merge/split/encrypt) |
| **Core** Python pkg | pdfplumber | Text/table extraction |
| **Core** Font | CJK fonts (TrueType: SimHei/Noto/WenQuanYi/Songti…) | Chinese text + covers |
| Optional | Node.js + npm | Only for the Creative/HTML pipeline |
| Optional | playwright (npm) | HTML-to-PDF for Creative pipeline |
| Optional | Chromium (via Playwright) | Headless rendering (large download) |
| Optional | tectonic | LaTeX/Academic PDF compilation |
| Optional render engine | LibreOffice | Office-to-PDF conversion only — see "LibreOffice (optional render engine)" below |

> **Covers no longer need Playwright.** All Report/Academic covers render with ReportLab
> (`scripts/cover_render.py`). Playwright/Chromium is required **only** for the Creative/poster
> pipeline and some HTML→PDF conversions; Tectonic **only** for the Academic/LaTeX route.
> Install these optional engines **on demand, after asking the user** (they involve large
> downloads / long first-run waits) — do not install them up front.
>
> **LibreOffice (Office→PDF) is optional on this deployment.** It is needed only for
> Office-to-PDF conversion; the report / academic / creative pipelines do not use it. **Probe
> before concluding it is missing** — the app injects `ZCODE_LIBREOFFICE_PATH` /
> `ZCODE_SKILL_ENGINE_ROOT`, and `soffice` may be installed but off-`PATH` (Windows:
> `C:\Program Files\LibreOffice\program\soffice.exe`; macOS:
> `/Applications/LibreOffice.app/Contents/MacOS/soffice`; Linux:
> `/opt/libreoffice*/program/soffice`). If it is genuinely absent, route to IT / the intranet —
> do **not** download from public mirrors (e.g. the Tsinghua TUNA mirror referenced by the
> upstream skill), and do **not** silently substitute Word/WPS/Keynote/Pages. See the intranet
> provisioning section at the end of this file.

### Manual Install by Platform

#### macOS

```bash
# ── Core (always) ──
brew install python3
python3 -m pip install reportlab pypdf PyMuPDF pikepdf pdfplumber

# ── Optional: Creative/HTML pipeline (install on demand, with user's OK — large Chromium download) ──
brew install node
npm install -g playwright@1.50.0 && npx playwright install chromium
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version

# ── Optional: Academic/LaTeX (install on demand — downloads packages on first run) ──
brew install tectonic
# ── Optional render engine: Office-to-PDF (IT-provisioned; see end of file) ──
brew install --cask libreoffice   # only if IT provisions it via the intranet
```

#### Linux (Debian/Ubuntu)

```bash
# ── Core (always) ──
sudo apt install python3 python3-pip
python3 -m pip install reportlab pypdf PyMuPDF pikepdf pdfplumber

# ── Optional: Creative/HTML pipeline (install on demand, with user's OK) ──
sudo apt install nodejs npm
npm install -g playwright@1.50.0 && npx playwright install chromium && npx playwright install-deps

# ── Optional: Academic/LaTeX (install on demand) ──
conda install -c conda-forge tectonic   # use Tsinghua mirror: conda config --add channels https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/
# ── Optional render engine: Office-to-PDF (IT-provisioned; see end of file) ──
sudo apt install libreoffice-core   # only if IT provisions it via the intranet
```

#### Windows (PowerShell)

```powershell
winget install Python.Python.3.11
winget install OpenJS.NodeJS.LTS
python -m pip install pikepdf pdfplumber pypdf reportlab PyMuPDF
npm install -g playwright@1.50.0
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
npx playwright install chromium
# optional:
scoop install tectonic                           # LaTeX
# optional render engine: Office-to-PDF (IT-provisioned; see end of file)
winget install TheDocumentFoundation.LibreOffice  # only if IT provisions it via the intranet
```

Alternative Windows package managers:
- `choco install python3 nodejs-lts`
- `scoop install python nodejs-lts`

---

## Step 3: Font Installation

Fonts are downloaded individually from CDN on first setup.

- **CDN base**: `https://z-cdn.chatglm.cn/office-skill/fonts/`
- **Font list**: `env_setup/font_list.txt` (78 fonts, one relative path per line)
- **Marker file**: `.office-skill-fonts-installed` in the user font directory prevents re-download
- Special characters in filenames (e.g., `[`, `]`) are URL-encoded automatically by the setup script

The setup scripts read `font_list.txt`, check which fonts are already installed, and download only the missing ones. Each font is saved flat (filename only) to the user font directory.

### CDN Directory Structure (78 fonts)

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

### Install Targets by Platform

| Platform | User Font Directory |
|----------|-------------------|
| macOS | `~/Library/Fonts/` |
| Linux | `~/.local/share/fonts/` (then run `fc-cache -f`) |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (per-user, no admin) |

### Manual Font Installation

If CDN is unreachable, download fonts manually. Example:

```bash
# Download a single font (use static-weight files, NOT variable fonts)
curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/chinese/NotoSansSC-Regular.ttf"
# Copy to user font dir
cp "NotoSansSC-Regular.ttf" ~/Library/Fonts/   # macOS
```

Or download all fonts listed in `font_list.txt`:

```bash
while read f; do
    encoded=$(echo "$f" | sed 's/\[/%5B/g; s/\]/%5D/g')
    curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/$encoded"
done < env_setup/font_list.txt
```

### Post-Install Variable

After font installation, `FONT_DIR` points to the user font directory:

| Platform | FONT_DIR |
|----------|---------------|
| macOS | `~/Library/Fonts` |
| Linux | `~/.local/share/fonts` |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### pip (Tsinghua mirror)

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  pikepdf pdfplumber pypdf reportlab PyMuPDF
```

### npm (npmmirror)

```bash
npm install -g playwright@1.50.0 --registry https://registry.npmmirror.com
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
```

### Playwright browser download (npmmirror)

```bash
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/ npx playwright install chromium
```

### Windows (PowerShell) China mirrors

```powershell
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn pikepdf pdfplumber pypdf reportlab PyMuPDF
npm install -g playwright@1.50.0 --registry https://registry.npmmirror.com
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright/"
npx playwright install chromium
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Node.js | https://npmmirror.com/mirrors/node/ |
| Python | https://npmmirror.com/mirrors/python/ |
| LibreOffice | *(not downloaded from public mirrors — provisioned by IT / intranet)* |

---

## LibreOffice (optional render engine) — Intranet provisioning

LibreOffice is **optional** on this deployment. It is needed only for Office→PDF conversion. The
report / academic / creative pipelines do not use it.

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
download. The Playwright / HTML fallback route (see `briefs/process.md`) remains the supported
path when no engine is present.

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
