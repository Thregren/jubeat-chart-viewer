<?php
declare(strict_types=1);
function private_file(string $path): void {
    if (is_link($path)) throw new RuntimeException('Unsafe storage');
}
function visitor_db(string $root): PDO {
    private_file($root);
    if (!is_dir($root) && !mkdir($root, 0700, true)) throw new RuntimeException('Storage unavailable');
    private_file($root . '/visitors.sqlite');
    $db = new PDO('sqlite:' . $root . '/visitors.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
    if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 2) {
        $db->exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
        try {
            $db->exec('CREATE TABLE IF NOT EXISTS counters(id INTEGER PRIMARY KEY CHECK(id=1),visitors INTEGER NOT NULL DEFAULT 0,views INTEGER NOT NULL DEFAULT 0);
                INSERT OR IGNORE INTO counters(id) VALUES(1);
                CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY,last_key TEXT,last_at INTEGER);
                CREATE TABLE IF NOT EXISTS rate_limits(ip TEXT PRIMARY KEY,bucket INTEGER NOT NULL,hits INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,charts TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,exported INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS receipt_dates ON receipts(at);
                CREATE INDEX IF NOT EXISTS pending_events ON events(exported,at);
                PRAGMA user_version=2; COMMIT;');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
    }
    return $db;
}
function visitor_secret(string $root): string {
    foreach (['secret','secret.lock'] as $name) private_file($root.'/'.$name);
    if (!is_file($root.'/secret')) {
        $lock=fopen($root.'/secret.lock','c');
        if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Secret lock unavailable');
        try {
            if (!is_file($root.'/secret')) {
                $temporary=tempnam($root,'.secret-');
                if (!$temporary) throw new RuntimeException('Secret unavailable');
                try {
                    $file=fopen($temporary,'wb');
                    if (!$file||fwrite($file,bin2hex(random_bytes(32)))!==64||!fflush($file)||!fsync($file)) throw new RuntimeException('Secret unavailable');
                    fclose($file);
                    if (!rename($temporary,$root.'/secret')) throw new RuntimeException('Secret publication failed');
                } finally {if (is_file($temporary)) unlink($temporary);}
            }
        } finally {flock($lock,LOCK_UN);fclose($lock);}
    }
    $secret=file_get_contents($root.'/secret');
    if (!is_string($secret)||!preg_match('/^[a-f0-9]{64}$/D',$secret)) throw new RuntimeException('Invalid secret');
    return $secret;
}
function visitor_export(PDO $db,string $root,int $batches=4): int {
    private_file($root.'/export.lock');$lock=fopen($root.'/export.lock','c');
    if (!$lock) throw new RuntimeException('Export lock unavailable');
    if (!flock($lock,LOCK_EX|LOCK_NB)) {fclose($lock);return 0;}
    $total=0;
    try {
        for ($batch=0;$batch<$batches;$batch++) {
            $rows=$db->query('SELECT id,day,payload FROM events WHERE exported=0 ORDER BY at,rowid LIMIT 50')->fetchAll(PDO::FETCH_ASSOC);
            if (!$rows) break;
            $days=[];
            foreach ($rows as $row) $days[$row['day']][]=$row;
            foreach ($days as $day=>$records) {
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D',$day)) throw new RuntimeException('Invalid log day');
                $path=$root.'/visits-'.$day.'.log';private_file($path);$file=fopen($path,'c+b');
                if (!$file || !flock($file,LOCK_EX)) throw new RuntimeException('Log unavailable');
                try {
                    // Recover a crash between append and SQLite acknowledgement.
                    // One batch is <=50 lines of <=32KiB, so its IDs fit this tail.
                    fseek($file,0,SEEK_END);$size=ftell($file);$start=max(0,$size-2*1024*1024);
                    fseek($file,$start);$tail=stream_get_contents($file);
                    if ($tail!==''&&!str_ends_with($tail,"\n")) {
                        $last=strrpos($tail,"\n");
                        if ($last===false && $start>0) throw new RuntimeException('Oversized partial log record');
                        $length=$last===false?0:$last+1;ftruncate($file,$start+$length);$tail=substr($tail,0,$length);
                    }
                    $seen=[];
                    foreach (explode("\n",$tail) as $line) {
                        $value=json_decode($line,true);
                        if (is_array($value)&&isset($value['event_id'])) $seen[$value['event_id']]=true;
                    }
                    fseek($file,0,SEEK_END);
                    foreach ($records as $record) {
                        if (isset($seen[$record['id']])) continue;
                        $line=$record['payload']."\n";
                        if (strlen($line)>32768||fwrite($file,$line)!==strlen($line)) throw new RuntimeException('Log write failed');
                        $seen[$record['id']]=true;
                    }
                    if (!fflush($file)||!fsync($file)) throw new RuntimeException('Log sync failed');
                } finally {flock($file,LOCK_UN);fclose($file);}
            }
            $db->exec('BEGIN IMMEDIATE');
            try {
                $q=$db->prepare('UPDATE events SET exported=1 WHERE id=?');
                foreach ($rows as $row) $q->execute([$row['id']]);
                $db->exec('COMMIT');$total+=count($rows);
            } catch (Throwable $error) {$db->exec('ROLLBACK');throw $error;}
        }
    } finally {flock($lock,LOCK_UN);fclose($lock);}
    return $total;
}
