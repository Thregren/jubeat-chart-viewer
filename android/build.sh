#!/bin/sh
# 打安卓「最小安装包」——不含曲库，只带网页前端 + 本地 http 服务。
#
# 为什么不用 Gradle：这一版压根没有第三方依赖（就一个 Activity + 一个手写的
# 127.0.0.1 静态服务），Gradle 要拖整套 AGP + 网络依赖，反而更容易在某台机器上
# 装不起来。直接 aapt2 → javac → d8 → zipalign → apksigner 五步，产物一样是
# 正常签名的 APK，而且每一步都看得见。
#
#   android/build.sh                     # 用默认 SDK 位置
#   ANDROID_HOME=/path/to/sdk android/build.sh
#
# 需要的 SDK 包：platforms;android-34、build-tools;35.0.0
# （tools/setup_android_sdk.sh 可以装；没装会在这里报缺哪个文件）
#
# 为什么 build-tools 至少要 35：34.0.0 里带的 R8(d8) 有个 bug —— JDK 21 的 javac
# 会给内部类的构造器写上「无名」的 MethodParameters（mandated 参数），R8 8.2 读到
# 那个空名字直接 NPE，凡是有匿名内部类的工程都编不过。35.0.0 的 R8 修了。
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/app"
OUT="$HERE/out"
WORK="$OUT/work"
DIST="$OUT/dist"

VERSION="$(cat "$REPO/VERSION")"
# 0.6.19 → 6019：主*10000 + 次*100 + 修订，Android 只要求「单调递增」
VERSION_CODE="$(printf '%s' "$VERSION" | awk -F. '{printf "%d", $1*10000 + $2*100 + $3}')"

ANDROID_HOME="${ANDROID_HOME:-/Users/Shared/android-sdk}"
BT_VERSION="${BT_VERSION:-35.0.0}"
PLATFORM_VERSION="${PLATFORM_VERSION:-34}"
BT="$ANDROID_HOME/build-tools/$BT_VERSION"
ANDROID_JAR="$ANDROID_HOME/platforms/android-$PLATFORM_VERSION/android.jar"
JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home}"
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"
KS="$HERE/keystore/jubeat-release.jks"
KS_ALIAS="${KS_ALIAS:-jubeat}"
KS_PASS="${KS_PASS:-jubeatviewer}"

NAME="jubeat-viewer-$VERSION-android-min"

missing=""
for f in "$BT/aapt2" "$BT/zipalign" "$BT/apksigner" "$JAVAC" "$KEYTOOL"; do
  [ -x "$f" ] || missing="$missing\n  $f"
done
[ -r "$ANDROID_JAR" ] || missing="$missing\n  $ANDROID_JAR"
if [ -n "$missing" ]; then
  echo "缺这些工具，先装 Android SDK（见文件头注释）：$missing" >&2
  exit 1
fi

if ! ls "$APP"/res/mipmap-*/ic_launcher.png >/dev/null 2>&1; then
  echo "▸ 先生成图标…"
  python3 "$REPO/tools/make_android_icon.py"
fi

echo "▸ 准备 $VERSION（versionCode=$VERSION_CODE）"
rm -rf "$WORK" "$DIST"
mkdir -p "$WORK/assets/www/static" "$WORK/classes" "$WORK/gen" "$DIST"

# 1) 前端铺进 assets —— 直接从仓库源文件拿，不在仓库里再存一份副本
cp "$REPO/铺面查看器/player/static/index.html" "$WORK/assets/www/index.html"
for f in "$REPO/铺面查看器/player/static"/*; do
  b="$(basename "$f")"
  case "$b" in
    index.html|*.py|*.pyc|.DS_Store) continue ;;
  esac
  cp "$f" "$WORK/assets/www/static/$b"
done
echo "  前端：$(( $(find "$WORK/assets" -type f | wc -l | tr -d ' ') )) 个文件"

# 2) 资源 + 清单 → 未签名的 APK（同时生成 R.java）
"$BT/aapt2" compile --dir "$APP/res" -o "$WORK/res.zip"
"$BT/aapt2" link \
  -o "$WORK/base.apk" \
  --manifest "$APP/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  -A "$WORK/assets" \
  --java "$WORK/gen" \
  --min-sdk-version 21 \
  --target-sdk-version "$PLATFORM_VERSION" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION" \
  "$WORK/res.zip"

# 3) Java → class
find "$APP/src" "$WORK/gen" -name '*.java' > "$WORK/sources.txt"
"$JAVAC" -source 8 -target 8 -nowarn -Xlint:-options \
  -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d "$WORK/classes" @"$WORK/sources.txt"

# 4) class → dex（安卓 5.0 起，单 dex 足够）
mkdir -p "$WORK/dex"
"$BT/d8" --min-api 21 --lib "$ANDROID_JAR" --output "$WORK/dex" \
  $(find "$WORK/classes" -name '*.class')

# 5) 把 dex 塞进 APK，再对齐、签名
cp "$WORK/base.apk" "$WORK/app.apk"
( cd "$WORK/dex" && zip -q -X "$WORK/app.apk" classes.dex )
"$BT/zipalign" -f -p 4 "$WORK/app.apk" "$WORK/aligned.apk"

if [ ! -f "$KS" ]; then
  echo "▸ 生成签名用的密钥（丢了就没法给已装的版本升级，别删）"
  mkdir -p "$(dirname "$KS")"
  "$KEYTOOL" -genkeypair -v -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Jubeat Viewer, O=thregren, C=CN" >/dev/null 2>&1
fi

"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$DIST/$NAME.apk" "$WORK/aligned.apk"

"$BT/apksigner" verify --print-certs "$DIST/$NAME.apk" | head -3

echo
echo "▸ 产物"
ls -lh "$DIST/$NAME.apk" | awk '{print "  " $5, $9}'
echo "  versionCode/Name: $(cat "$REPO/VERSION") / $VERSION_CODE"
"$BT/aapt2" dump badging "$DIST/$NAME.apk" 2>/dev/null | grep -E "^package|^sdkVersion|^targetSdkVersion|^application-label" | sed 's/^/  /'
