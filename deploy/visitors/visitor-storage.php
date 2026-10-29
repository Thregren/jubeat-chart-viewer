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
    if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 3) {
        $db->exec('BEGIN IMMEDIATE');
        try {
            // Recheck after taking the lock: another request may have migrated first.
            if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 3) {
                $db->exec('ALTER TABLE visitors ADD COLUMN last_seen INTEGER; UPDATE visitors SET last_seen=last_at;
                    CREATE INDEX IF NOT EXISTS visitors_last_seen ON visitors(last_seen); PRAGMA user_version=3;');
            }
            $db->exec('COMMIT');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
    }
    if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 4) {
        $db->exec('BEGIN IMMEDIATE');
        try {
            // Recheck after taking the lock. This projection serves the public
            // seven-day ranking without exposing private event payloads.
            if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 4) {
                $db->exec('CREATE TABLE IF NOT EXISTS song_events(
                        event_id TEXT PRIMARY KEY,
                        at INTEGER NOT NULL,
                        song TEXT NOT NULL,
                        title TEXT NOT NULL,
                        chart TEXT NOT NULL,
                        bot INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS song_events_recent ON song_events(at);
                    CREATE TABLE IF NOT EXISTS visitor_rate_limits(
                        visitor TEXT PRIMARY KEY,
                        bucket INTEGER NOT NULL,
                        hits INTEGER NOT NULL
                    );');
                $insert=$db->prepare('INSERT OR IGNORE INTO song_events(event_id,at,song,title,chart,bot) VALUES(?,?,?,?,?,?)');
                $hasEvents=(int)$db->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='events'")->fetchColumn();
                if ($hasEvents) {
                    $rows=$db->query('SELECT id,at,payload FROM events ORDER BY at,rowid');
                    $count=0;
                    foreach ($rows as $row) {
                        if (++$count>2000000) throw new RuntimeException('Event backfill budget exceeded');
                        $entry=json_decode($row['payload'],true,32);
                        if (!is_array($entry)||($entry['event']??null)!=='song'
                            ||!is_string($entry['song']??null)||!is_string($entry['title']??null)
                            ||!is_string($entry['chart']??null)) continue;
                        $ua=strtolower((string)($entry['ua']??''));
                        $bot=preg_match('/headlesschrome|bot\\b|spider|crawler|playwright|puppeteer|jubeatdeploymentcheck|jubeatstatsqa|statsqa|python-requests|python-urllib|curl\\//', $ua) ? 1 : 0;
                        $insert->execute([$row['id'],$row['at'],$entry['song'],$entry['title'],$entry['chart'],$bot]);
                    }
                }
                $db->exec('PRAGMA user_version=4');
            }
            $db->exec('COMMIT');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
    }
    return $db;
}
function visitor_today(PDO $db, int $now): int {
    $day=(new DateTimeImmutable('@'.$now))->setTimezone(new DateTimeZone('Asia/Shanghai'))->setTime(0,0);
    $q=$db->prepare('SELECT COUNT(*) FROM visitors WHERE last_seen>=? AND last_seen<?');
    $q->execute([$day->getTimestamp(),$day->modify('+1 day')->getTimestamp()]);
    return (int)$q->fetchColumn();
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
function visitor_admit(PDO $db,string $ip,int $now): bool {
    $bucket=intdiv($now,60);$key=hash('sha256',$ip);
    // Reserve the quota before catalog reads; rejected song names must not bypass it.
    $db->exec('BEGIN IMMEDIATE');
    try {
        $q=$db->prepare('INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END,bucket=excluded.bucket');
        $q->execute([$key,$bucket]);
        $q=$db->prepare('SELECT hits FROM rate_limits WHERE ip=?');$q->execute([$key]);
        $allowed=(int)$q->fetchColumn()<=120;
        $db->exec('DELETE FROM rate_limits WHERE bucket < '.($bucket-2));
        $db->exec('COMMIT');return $allowed;
    } catch (Throwable $error) {$db->exec('ROLLBACK');throw $error;}
}
function visitor_admit_cookie(PDO $db,string $visitor,int $now): bool {
    $bucket=intdiv($now,3600);
    $q=$db->prepare('INSERT INTO visitor_rate_limits VALUES(?,?,1) ON CONFLICT(visitor) DO UPDATE SET hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END,bucket=excluded.bucket');
    $q->execute([$visitor,$bucket]);
    $q=$db->prepare('SELECT hits FROM visitor_rate_limits WHERE visitor=?');$q->execute([$visitor]);
    $allowed=(int)$q->fetchColumn()<=300;
    $db->exec('DELETE FROM visitor_rate_limits WHERE bucket < '.($bucket-2));
    return $allowed;
}
function visitor_popular(PDO $db,int $now): array {
    $q=$db->prepare('SELECT song,title,COUNT(*) selections,MAX(at) last_at FROM song_events
        WHERE at>=? AND bot=0 GROUP BY song,title
        ORDER BY selections DESC,last_at DESC,song ASC LIMIT 10');
    $q->execute([$now-7*86400]);
    $rows=[];
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $rows[]=[
            'song'=>(string)$row['song'],
            'title'=>(string)$row['title'],
            'selections'=>(int)$row['selections'],
        ];
    }
    return $rows;
}
function visitor_backup(PDO $db,string $root,string $directory,int $keep): array {
    if ($keep<1||$keep>90) throw new RuntimeException('Invalid backup retention');
    if (!is_dir($directory)&&!mkdir($directory,0700,true)) throw new RuntimeException('Backup directory unavailable');
    private_file($directory);
    $directory=realpath($directory);
    $site=realpath(dirname($root));
    if (!$directory||!$site) throw new RuntimeException('Backup path unavailable');
    if ($directory===$site||str_starts_with($directory.DIRECTORY_SEPARATOR,$site.DIRECTORY_SEPARATOR)) {
        throw new RuntimeException('Backup directory must be outside the website');
    }
    chmod($directory,0700);
    $stamp=gmdate('Ymd\THis\Z');
    $suffix=bin2hex(random_bytes(4));
    $base='jubeat-visitors-'.$stamp.'-'.$suffix;
    $target=$directory.'/'.$base.'.sqlite';
    $temporary=$directory.'/.'.$base.'.tmp';
    try {
        $db->exec('VACUUM INTO '.$db->quote($temporary));
        if (!is_file($temporary)||!rename($temporary,$target)) throw new RuntimeException('Database backup failed');
        chmod($target,0600);
        if (!copy($root.'/secret',$target.'.secret')) throw new RuntimeException('Secret backup failed');
        chmod($target.'.secret',0600);
    } finally {
        if (is_file($temporary)) unlink($temporary);
    }
    $backups=glob($directory.'/jubeat-visitors-*.sqlite')?:[];
    usort($backups,fn(string $a,string $b):int=>strcmp($b,$a));
    $removed=0;
    foreach (array_slice($backups,$keep) as $old) {
        $check=realpath($old);
        if (!$check||!str_starts_with($check,$directory.DIRECTORY_SEPARATOR)) continue;
        if (unlink($check)) $removed++;
        if (is_file($check.'.secret')&&unlink($check.'.secret')) $removed++;
    }
    return ['file'=>basename($target),'bytes'=>(int)filesize($target),'kept'=>min(count($backups),$keep),'removed'=>$removed];
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
