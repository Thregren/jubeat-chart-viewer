<?php
declare(strict_types=1);
// Mounted only at /api/visitors by nginx; never serve the storage directory.
umask(0077);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply(int $status, array $data): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function private_file(string $path): void {
    if (is_link($path)) throw new RuntimeException('Unsafe storage');
}
$db = null;
try {
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if (!in_array($method, ['GET', 'POST'], true)) {
        header('Allow: GET, POST'); reply(405, ['error' => 'method_not_allowed']);
    }
    $event = null;
    if ($method === 'POST') {
        $expected = getenv('VISITOR_STATS_ORIGIN') ?: 'https://' . ($_SERVER['SERVER_NAME'] ?? '');
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $expected) reply(403, ['error' => 'origin_not_allowed']);
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') reply(415, ['error' => 'json_required']);
        if (!ctype_digit((string)($_SERVER['CONTENT_LENGTH'] ?? '')) || (int)$_SERVER['CONTENT_LENGTH'] > 2048) reply(413, ['error' => 'request_too_large']);
        $body = file_get_contents('php://input', false, null, 0, 2049);
        $event = json_decode($body ?: '', true);
        if (!is_array($event) || !in_array($event['event'] ?? null, ['page', 'song'], true)) reply(400, ['error' => 'invalid_event']);
        if ($event['event'] === 'song' && (!is_string($event['song'] ?? null) || strlen($event['song']) > 512 || !is_string($event['chart'] ?? null) || strlen($event['chart']) > 32)) reply(400, ['error' => 'invalid_song']);
    }
    $root = getenv('VISITOR_STATS_ROOT') ?: __DIR__;
    private_file($root);
    if (!is_dir($root) && !mkdir($root, 0700, true)) throw new RuntimeException('Storage unavailable');
    foreach (['visitors.sqlite', 'secret', 'secret.lock'] as $name) private_file($root . '/' . $name);
    $db = new PDO('sqlite:' . $root . '/visitors.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    $db->exec('CREATE TABLE IF NOT EXISTS counters (id INTEGER PRIMARY KEY CHECK(id=1), visitors INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO counters(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, last_key TEXT, last_at INTEGER);
        CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT PRIMARY KEY, bucket INTEGER NOT NULL, hits INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, title TEXT NOT NULL, charts TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    if ($event !== null) {
        $db->exec('BEGIN IMMEDIATE');
        $now = time();
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        if (!filter_var($ip, FILTER_VALIDATE_IP)) throw new RuntimeException('Client address unavailable');
        $ipHash = hash('sha256', $ip); $bucket = intdiv($now, 60);
        $q = $db->prepare('INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END,bucket=excluded.bucket'); $q->execute([$ipHash, $bucket]);
        $q = $db->prepare('SELECT hits FROM rate_limits WHERE ip=?'); $q->execute([$ipHash]);
        if ((int)$q->fetchColumn() > 120) { $db->exec('COMMIT'); header('Retry-After: 60'); reply(429, ['error'=>'rate_limited']); }
        $db->exec('DELETE FROM rate_limits WHERE bucket < ' . ($bucket - 2));
        $song = null; $title = null; $chart = null;
        if ($event['event'] === 'song') {
            $catalog = getenv('VISITOR_STATS_CATALOG') ?: dirname($root) . '/data/library.json';
            $st = stat($catalog);
            if (!$st) throw new RuntimeException('Catalog unavailable');
            $signature = implode(':', [$st['ino'], $st['size'], $st['mtime'], $st['ctime']]);
            $q = $db->query("SELECT value FROM meta WHERE key='catalog'");
            if ($q->fetchColumn() !== $signature) {
                $data = json_decode(file_get_contents($catalog), true, 64, JSON_THROW_ON_ERROR);
                if (!is_array($data['songs'] ?? null)) throw new RuntimeException('Invalid catalog');
                $db->exec('DELETE FROM catalog');
                $q = $db->prepare('INSERT INTO catalog VALUES(?,?,?)');
                foreach ($data['songs'] as $item) $q->execute([$item['id'], $item['title'], json_encode(array_column($item['charts'], 'code'))]);
                $q = $db->prepare("INSERT INTO meta VALUES('catalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"); $q->execute([$signature]);
            }
            $q = $db->prepare('SELECT title,charts FROM catalog WHERE id=?'); $q->execute([$event['song']]); $row = $q->fetch(PDO::FETCH_ASSOC);
            if (!$row || !in_array($event['chart'], json_decode($row['charts'], true), true)) { $db->exec('COMMIT'); reply(422, ['error'=>'unknown_chart']); }
            $song = $event['song']; $title = $row['title']; $chart = $event['chart'];
        }
        $lock = fopen($root . '/secret.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Secret lock unavailable');
        if (!is_file($root . '/secret')) {
            $f = fopen($root . '/secret', 'x');
            if (!$f || fwrite($f, bin2hex(random_bytes(32))) !== 64) throw new RuntimeException('Secret unavailable');
            fclose($f);
        }
        $secret = file_get_contents($root . '/secret'); flock($lock, LOCK_UN); fclose($lock);
        if (!is_string($secret) || !preg_match('/^[a-f0-9]{64}$/D', $secret)) throw new RuntimeException('Invalid secret');
        $cookie = $_COOKIE['jv_visitor'] ?? ''; $parts = is_string($cookie) ? explode('.', $cookie) : [];
        if (count($parts) !== 2 || !preg_match('/^[a-f0-9]{32}$/D', $parts[0]) || !hash_equals(hash_hmac('sha256', $parts[0], $secret), $parts[1])) {
            $token = bin2hex(random_bytes(16)); $cookie = $token . '.' . hash_hmac('sha256', $token, $secret);
            setcookie('jv_visitor', $cookie, ['expires'=>$now+31536000,'path'=>'/','secure'=>true,'httponly'=>true,'samesite'=>'Lax']);
        } else $token = $parts[0];
        $visitor = hash('sha256', $token);
        $q = $db->prepare('INSERT OR IGNORE INTO visitors(id) VALUES(?)'); $q->execute([$visitor]);
        if ($q->rowCount()) $db->exec('UPDATE counters SET visitors=visitors+1 WHERE id=1');
        $key = hash('sha256', json_encode([$event['event'], $song, $chart]));
        $q = $db->prepare('SELECT last_key,last_at FROM visitors WHERE id=?'); $q->execute([$visitor]); $previous = $q->fetch(PDO::FETCH_ASSOC);
        if ($previous['last_key'] !== $key || $now-(int)$previous['last_at'] >= 10) {
            $entry = ['time'=>gmdate('c', $now),'event'=>$event['event'],'visitor'=>substr($visitor,0,16),'ip'=>$ip,'song'=>$song,'title'=>$title,'chart'=>$chart,'ua'=>substr($_SERVER['HTTP_USER_AGENT'] ?? '',0,1024)];
            $path = $root . '/visits-' . gmdate('Y-m-d',$now) . '.log'; private_file($path);
            $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
            $f = fopen($path, 'ab');
            if (!$f || !flock($f, LOCK_EX) || fwrite($f, $line) !== strlen($line) || !fflush($f)) throw new RuntimeException('Log unavailable');
            flock($f, LOCK_UN); fclose($f);
            $q = $db->prepare('UPDATE visitors SET last_key=?,last_at=? WHERE id=?'); $q->execute([$key,$now,$visitor]);
            if ($event['event']==='page') $db->exec('UPDATE counters SET views=views+1 WHERE id=1');
        }
        $db->exec('COMMIT');
    }
    $counts = $db->query('SELECT visitors,views FROM counters WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    reply(200, ['visitors'=>(int)$counts['visitors'],'views'=>(int)$counts['views']]);
} catch (Throwable $e) {
    if ($db instanceof PDO) { try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {} }
    error_log('[visitor-stats] ' . get_class($e));
    reply(503, ['error'=>'statistics_unavailable']);
}
