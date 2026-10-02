#!/bin/bash
# 在源站上把「已经传上去的 Vorbis 音源」就地重编码成 Ogg Opus 80k。
#
# 为什么需要它：换了音源编码时，本地重建是几秒钟的事，但把新的 1.5 GB 重新
# 走一遍 API 上传要几小时。源站上本来就有整套旧音源，直接在服务器上转更快。
#
#   scp deploy/reencode-audio-opus.sh root@host:/www/.jubeat-encode/
#   ssh root@host 'bash /www/.jubeat-encode/reencode-audio-opus.sh'
#
# 参数与 tools/audio_opus.py 一致；产物先落到 $DST，全部跑完再由人确认后原子换目录，
# 线上不会看到半成品。断点续跑：已经转好的文件会跳过，中断了直接重跑。
#
# 换路径或小规模试跑：
#   JUBEAT_AUDIO_SRC=/tmp/old JUBEAT_AUDIO_DST=/tmp/new \
#     bash deploy/reencode-audio-opus.sh
set -u

SRC="${JUBEAT_AUDIO_SRC:-/www/wwwroot/ub.thregren.world/media/audio}"
DST="${JUBEAT_AUDIO_DST:-/www/.jubeat-audio-new}"
BITRATE="${JUBEAT_OPUS_BITRATE:-80k}"
JOBS="${JUBEAT_REENCODE_JOBS:-2}"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# ---------- 工人模式：$2 = 音源路径（绝对或相对） ----------
if [ "${1:-}" = "--worker" ]; then
  arg="${2:?缺少音源路径}"
  case "$arg" in
    /*) src="$arg" ;;
    *)  src="$SRC/$arg" ;;
  esac
  rel="${src#"$SRC"/}"
  dst="$DST/$rel"
  tmp="$dst.tmp$$"

  # 任何一步失败就原样复制源文件：宁可包大一点，也不能让某首歌没声音
  fallback() {
    echo "FALLBACK $1 $rel"
    mkdir -p "$(dirname "$dst")"
    rm -f "$tmp"
    cp -f "$src" "$dst"
    exit 0
  }

  [ -s "$dst" ] && exit 0          # 断点续跑
  mkdir -p "$(dirname "$dst")"

  src_dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" 2>/dev/null) || fallback "ffprobe-src"
  [ -n "$src_dur" ] || fallback "no-duration"

  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$src" -map 0:a:0 \
    -c:a libopus -b:a "$BITRATE" -vbr on -compression_level 10 \
    -application audio -frame_duration 20 -map_metadata -1 \
    -f ogg "$tmp" || fallback "ffmpeg"

  codec=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$tmp" 2>/dev/null)
  [ "$codec" = "opus" ] || fallback "codec=$codec"

  dst_dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp" 2>/dev/null)
  awk -v a="$src_dur" -v b="$dst_dur" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 0.5) }' \
    || fallback "duration $src_dur -> $dst_dur"

  mv -f "$tmp" "$dst"
  exit 0
fi

# ---------- 调度模式 ----------
command -v ffmpeg >/dev/null || { echo "找不到 ffmpeg，放弃"; exit 1; }
[ -d "$SRC" ] || { echo "源目录不存在：${SRC}"; exit 1; }

mkdir -p "$DST"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
# 用 NUL 分隔：曲名里有空格、括号、日文，按行分会被切碎
find "$SRC" -type f -name '*.ogg' -print0 > "$list"
total=$(tr -cd '\0' < "$list" | wc -c | tr -d ' ')
echo "开始：${total} 个音源 | 并行 ${JOBS} | 码率 ${BITRATE}"

start=$(date +%s)
xargs -0 -P "$JOBS" -n 1 nice -n 19 "$SELF" --worker < "$list"
elapsed=$(( $(date +%s) - start ))

done_n=$(find "$DST" -type f -name '*.ogg' | wc -l | tr -d ' ')
# 抽查回退：输出不是 Opus 头，说明这个文件是原样复制过来的
fallback_n=$(find "$DST" -type f -name '*.ogg' -print0 \
  | xargs -0 -P "$JOBS" -n 1 sh -c 'head -c 64 "$1" | grep -q OpusHead || echo x' _ \
  | wc -l | tr -d ' ')
echo "完成：${done_n}/${total} 个 | 回退文件 ${fallback_n} 个 | 耗时 ${elapsed}s"
if [ "$done_n" -ne "$total" ] || [ "$fallback_n" -ne 0 ]; then
  echo "注意：数量不符或存在回退文件，先别删旧目录"
fi
