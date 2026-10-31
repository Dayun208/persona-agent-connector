#!/bin/bash
# PASC 用 NapCat 安装器（macOS / Apple Silicon）
# 原理：复制一份 QQ.app → 把入口指向 NapCat → 临时重签名 → 只运行副本。
# /Applications/QQ.app 始终不动，日常 QQ 仍是苹果原签。
set -euo pipefail

BASE="$HOME/napcat-mac"
QQ_APP="/Applications/QQ.app"
RUNTIME="$BASE/QQNapCatRuntime.app"
PAYLOAD="$BASE/NapCatShell"
MJS="$PAYLOAD/napcat.mjs"

log() { printf '\033[36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ -d "$QQ_APP" ] || die "找不到 $QQ_APP"
command -v codesign >/dev/null || die "缺少 Xcode 命令行工具：xcode-select --install"
[ -f "$MJS" ] || die "NapCat 未解压到 $PAYLOAD"

if pgrep -f "$QQ_APP/Contents/MacOS/QQ" >/dev/null 2>&1; then
  die "桌面 QQ 还在运行，请先完全退出（Cmd+Q 或 Dock 右键退出）"
fi

QQ_VER=$(python3 -c "import json;d=json.load(open('$QQ_APP/Contents/Resources/app/package.json'));print(d['version'])" 2>/dev/null || echo unknown)
log "本机 QQ 版本: $QQ_VER"
log "NapCat 版本: $(python3 -c "import json;d=json.load(open('$PAYLOAD/package.json'));print(d.get('version','?'))" 2>/dev/null || echo '?')"

# ---------- 1. 本机 QQ 版本是否在补丁表里 ----------
python3 - "$MJS" "$QQ_VER" <<'PY'
import re, sys, pathlib
mjs, ver = sys.argv[1], sys.argv[2]
s = pathlib.Path(mjs).read_text(errors='ignore')
key = f'"{ver}-arm64"'
print(f'\033[36m[install]\033[0m 补丁表命中 {key}: ' + ('✅' if key in s else '❌ 不在支持列表'))
sys.exit(0 if key in s else 3)
PY
[ $? -eq 3 ] && die "当前 QQ 版本不在 NapCat 4.18.42 的补丁表内，需要升级 QQ 或换 NapCat 版本"

# ---------- 2. 复制 QQ ----------
if [ -d "$RUNTIME" ]; then
  log "删除旧的运行副本"
  rm -rf "$RUNTIME"
fi
log "复制 QQ.app → ${RUNTIME}（约 1GB，需要一点时间）"
ditto "$QQ_APP" "$RUNTIME"
xattr -cr "$RUNTIME" 2>/dev/null || true

# ---------- 3. 写入口 ----------
APP_RES="$RUNTIME/Contents/Resources/app"
PKG_JSON="$APP_RES/package.json"
[ -f "$PKG_JSON" ] || die "副本里找不到 $PKG_JSON"

cat > "$APP_RES/loadNapCat-pasc.js" <<'LOADER'
// 由 PASC 安装脚本生成：只存在于私有副本中。
// package.json 的 main 指向这里，再由它加载 NapCat。
const { pathToFileURL } = require('url');
const mjs = process.env.NAPCAT_MJS_PATH;
if (!mjs) {
  console.error('[PASC] NAPCAT_MJS_PATH 未设置');
  process.exit(1);
}
import(pathToFileURL(mjs).href).catch((e) => {
  console.error('[PASC] 加载 napcat.mjs 失败:', e);
  process.exit(1);
});
LOADER

ORIG_MAIN=$(grep -oE '"main": *"[^"]*"' "$PKG_JSON" | head -1 || true)
[ -n "$ORIG_MAIN" ] || die "package.json 里没有 main 字段"
log "原入口: $ORIG_MAIN"
sed -i '' -E 's/"main": *"[^"]*"/"main": ".\/loadNapCat-pasc.js"/' "$PKG_JSON"

# ---------- 4. 重签名（浅签名，带必要 entitlements） ----------
cat > "$BASE/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
</dict>
</plist>
PLIST

log "重新签名（临时自签名，仅本机）"
codesign --force --sign - --entitlements "$BASE/entitlements.plist" "$RUNTIME" 2>&1 | sed 's/^/    /'
codesign --verify --verbose=1 "$RUNTIME" 2>&1 | tail -2 | sed 's/^/    /' || die "签名校验失败"

echo "$QQ_VER" > "$BASE/.pasc-runtime-source-version"

# ---------- 5. 启动器 ----------
cat > "$BASE/start-napcat.sh" <<LAUNCH
#!/bin/bash
# 启动 NapCat（运行的是 QQ 的私有副本，不影响日常 QQ）
set -euo pipefail
BASE="\$HOME/napcat-mac"
export NAPCAT_MJS_PATH="\$BASE/NapCatShell/napcat.mjs"
export NAPCAT_QQ_PKG_JSON="\$BASE/QQNapCatRuntime.app/Contents/Resources/app/package.json"

if pgrep -f "QQNapCatRuntime.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
  echo "NapCat 已在运行"
  exit 0
fi

cd "\$BASE/NapCatShell"
exec "\$BASE/QQNapCatRuntime.app/Contents/MacOS/QQ" --no-sandbox
LAUNCH
chmod +x "$BASE/start-napcat.sh"

log "完成。启动命令：$BASE/start-napcat.sh"
