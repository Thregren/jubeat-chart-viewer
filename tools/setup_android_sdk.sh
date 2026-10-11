#!/bin/sh
# 装一份打安卓包要用的最小 SDK（cmdline-tools + android-34 平台 + build-tools 35）。
#
#   tools/setup_android_sdk.sh              # 装到 /Users/Shared/android-sdk
#   ANDROID_HOME=/path/to/sdk tools/setup_android_sdk.sh
#
# 只装这三样，不装 emulator / system-image / NDK：
#   platforms;android-34   —— 编 Java 要的 android.jar
#   build-tools;35.0.0     —— aapt2 / d8 / zipalign / apksigner（34 的 d8 有 bug，见 build.sh）
#
# 为啥放 /Users/Shared 而不是仓库里：这是一套 1 GB 出头的工具链，跟源码没关系，
# 放仓库会被 git 追着跑；这个位置所有用户都能读写，CI 和本地都方便。
set -e

ANDROID_HOME="${ANDROID_HOME:-/Users/Shared/android-sdk}"
CMDLINE_ZIP="https://dl.google.com/android/repository/commandlinetools-mac-13114758_latest.zip"
JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home}"

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "没找到 JDK 21：$JAVA_HOME" >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  echo "▸ 下载 cmdline-tools…"
  tmp="$(mktemp -d)"
  curl -L --retry 3 -o "$tmp/cmdline-tools.zip" "$CMDLINE_ZIP"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  unzip -q "$tmp/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

echo "▸ 接受许可 + 安装 platforms;android-34 / build-tools;35.0.0"
yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --sdk_root="$ANDROID_HOME" "platforms;android-34" "build-tools;35.0.0"

echo
echo "装好了：$ANDROID_HOME"
ls "$ANDROID_HOME/platforms" "$ANDROID_HOME/build-tools" | sed 's/^/  /'
