<?php
/**
 * jubeat 铺面查看器 —— PHP 单文件入口（服务器上解压即用）
 *
 * 这个目录本身就是一个完整的静态站点：index.html / static / data / media / markers。
 * 本文件只做三件事，其余全部由它直接发文件：
 *
 *   1. 静态文件带 ETag / Last-Modified，命中就回 304
 *   2. 音源支持 HTTP Range（206）—— 播放器要拖进度条就必须有它
 *   3. json / js / css / html 在浏览器支持时用 gzip 传（library.json 约 400 KB → 约 90 KB）
 *
 * 用 nginx（宝塔）时按 nginx-php.conf.example 配一下，静态文件会由 nginx 直接发，
 * 这个脚本只在目录请求时兜底；不配也能跑，只是所有请求都过一遍 PHP。
 */
declare(strict_types=1);

/** 站点根目录（本文件所在目录） */
if (!defined('JUBEAT_PHP_ROOT')) {
    define('JUBEAT_PHP_ROOT', __DIR__);
}
/** 超过这个大小就不做 gzip（音频、图片本来也不需要） */
const JUBEAT_GZIP_MAX = 8388608;
/** 一次读多少字节往外写 */
const JUBEAT_CHUNK = 262144;

function jubeat_mime(string $path): string
{
    static $map = [
        'html' => 'text/html; charset=utf-8',
        'htm'  => 'text/html; charset=utf-8',
        'css'  => 'text/css; charset=utf-8',
        'js'   => 'text/javascript; charset=utf-8',
        'mjs'  => 'text/javascript; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'txt'  => 'text/plain; charset=utf-8',
        'svg'  => 'image/svg+xml',
        'png'  => 'image/png',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
        'gif'  => 'image/gif',
        'ico'  => 'image/x-icon',
        'ogg'  => 'audio/ogg',
        'oga'  => 'audio/ogg',
        'mp3'  => 'audio/mpeg',
        'wav'  => 'audio/wav',
        'woff' => 'font/woff',
        'woff2'=> 'font/woff2',
        'ttf'  => 'font/ttf',
    ];
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return $map[$ext] ?? 'application/octet-stream';
}

function jubeat_is_compressible(string $path): bool
{
    static $ok = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt'];
    return in_array(strtolower(pathinfo($path, PATHINFO_EXTENSION)), $ok, true);
}

/** 缓存策略：素材类长缓存，入口与索引每次都回来问一声 */
function jubeat_cache_control(string $rel): string
{
    if (preg_match('#^(media|markers|static)/#', $rel)) {
        return 'public, max-age=604800';
    }
    return 'no-cache';
}

function jubeat_fail(int $code, string $message): void
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: text/plain; charset=utf-8');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
        echo $message, "\n";
    }
}

/**
 * 把 URI 解析成磁盘上的真实文件；非法路径统一返回 null（调用方回 404）。
 */
function jubeat_resolve(string $uri): ?array
{
    if ($uri === '' || $uri[0] !== '/') {
        $uri = '/' . $uri;
    }
    if (strpos($uri, "\0") !== false || preg_match('#(^|/)\.#', $uri)) {
        return null;                       // 目录穿越（..）与隐藏文件（.htaccess/.git…）一律不放行
    }
    $rel = rawurldecode(ltrim($uri, '/'));
    if ($rel === '' || substr($rel, -1) === '/') {
        $rel .= 'index.html';
    }
    $real = realpath(JUBEAT_PHP_ROOT . '/' . $rel);
    if ($real === false || !is_file($real)) {
        return null;
    }
    $root = realpath(JUBEAT_PHP_ROOT);
    if ($root === false || strncmp($real, $root . DIRECTORY_SEPARATOR, strlen($root) + 1) !== 0) {
        return null;                       // 落点跑出站点根目录
    }
    return ['path' => $real, 'rel' => str_replace(DIRECTORY_SEPARATOR, '/', substr($real, strlen($root) + 1))];
}

/** 解析 Range 头；返回 [start, end] 或 null（无 Range / 不合法）；end 为含端点 */
function jubeat_parse_range(string $header, int $size): ?array
{
    if (!preg_match('/^bytes=(\d*)-(\d*)$/', trim($header), $m)) {
        return null;
    }
    $startRaw = $m[1];
    $endRaw = $m[2];
    if ($startRaw === '' && $endRaw === '') {
        return null;
    }
    if ($startRaw === '') {                // bytes=-N：最后 N 字节
        $len = (int) $endRaw;
        if ($len <= 0) {
            return null;
        }
        $start = max(0, $size - $len);
        $end = $size - 1;
    } else {
        $start = (int) $startRaw;
        $end = $endRaw === '' ? $size - 1 : (int) $endRaw;
    }
    if ($start > $end || $start >= $size) {
        return null;                       // 不满足 → 交给调用方回 416
    }
    return [$start, min($end, $size - 1)];
}

/** 流式发文件（分块写，不把大文件读进内存） */
function jubeat_stream(string $path, int $start, int $end, bool $headOnly): void
{
    $fp = fopen($path, 'rb');
    if ($fp === false) {
        return;
    }
    if ($start > 0) {
        fseek($fp, $start);
    }
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fp) && !connection_aborted()) {
        $buf = fread($fp, (int) min(JUBEAT_CHUNK, $left));
        if ($buf === false) {
            break;
        }
        if (!$headOnly) {
            echo $buf;
            flush();
        }
        $left -= strlen($buf);
    }
    fclose($fp);
}

/**
 * 发一个文件：处理缓存校验、gzip、Range。$headers 只需要传 if-none-match / if-modified-since。
 *
 * $method 传 GET / HEAD。
 */
function jubeat_send(string $path, string $rel, string $method, array $headers, bool $allowGzip = true): void
{
    $size = (int) filesize($path);
    $mtime = (int) filemtime($path);
    $etag = '"' . dechex($mtime) . '-' . dechex($size) . '"';
    $headOnly = $method === 'HEAD';
    $rangeHeader = (string) ($headers['range'] ?? '');

    header('Accept-Ranges: bytes');
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('Cache-Control: ' . jubeat_cache_control($rel));

    // 带 Range 的请求不做 304（Safari 有时会拿旧的缓存块）
    $noneMatch = trim((string) ($headers['if-none-match'] ?? ''));
    $notModified = $noneMatch !== ''
        ? in_array($etag, array_map('trim', explode(',', $noneMatch)), true)
        : (($headers['if-modified-since'] ?? '') !== ''
            && strtotime((string) $headers['if-modified-since']) >= $mtime);
    if ($rangeHeader === '' && $notModified) {
        http_response_code(304);
        return;
    }

    header('Content-Type: ' . jubeat_mime($path));

    if ($rangeHeader !== '') {
        $range = jubeat_parse_range($rangeHeader, $size);
        if ($range === null) {
            http_response_code(416);
            header('Content-Range: bytes */' . $size);
            return;
        }
        [$start, $end] = $range;
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
        header('Content-Length: ' . ($end - $start + 1));
        jubeat_stream($path, $start, $end, $headOnly);
        return;
    }

    // 文本类走 gzip（只对整文件请求）
    if ($allowGzip && $size <= JUBEAT_GZIP_MAX && $size > 0 && jubeat_is_compressible($path)
        && stripos((string) ($headers['accept-encoding'] ?? ''), 'gzip') !== false) {
        $raw = (string) file_get_contents($path);
        $gz = gzencode($raw, 6);
        if ($gz !== false && strlen($gz) < strlen($raw)) {
            header('Content-Encoding: gzip');
            header('Vary: Accept-Encoding');
            header('Content-Length: ' . strlen($gz));
            if (!$headOnly) {
                echo $gz;
            }
            return;
        }
    }

    http_response_code(200);
    header('Content-Length: ' . $size);
    jubeat_stream($path, 0, max(0, $size - 1), $headOnly);
}

/** 入口：解析请求 → 发文件 / 404 */
function jubeat_php_run(): void
{
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method !== 'GET' && $method !== 'HEAD') {
        jubeat_fail(405, '405 Method Not Allowed');
        return;
    }
    while (ob_get_level() > 0) {
        ob_end_clean();                    // Range 必须自己控制输出，不能有缓冲
    }
    @set_time_limit(0);
    $uri = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $file = jubeat_resolve($uri === '' ? '/' : $uri);
    if ($file === null) {
        jubeat_fail(404, '404 Not Found');
        return;
    }
    jubeat_send($file['path'], $file['rel'], $method, [
        'range' => $_SERVER['HTTP_RANGE'] ?? '',
        'if-none-match' => $_SERVER['HTTP_IF_NONE_MATCH'] ?? '',
        'if-modified-since' => $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '',
        'accept-encoding' => $_SERVER['HTTP_ACCEPT_ENCODING'] ?? '',
    ]);
}

if (!defined('JUBEAT_PHP_NO_RUN')) {
    jubeat_php_run();
}
