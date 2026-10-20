<?php
declare(strict_types=1);
// Mount only /api/visitors; all storage and helper files remain private.
umask(0077);ini_set('display_errors','0');ini_set('log_errors','1');
require_once __DIR__.'/visitor-storage.php';
require_once __DIR__.'/visitor-catalog.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');
function reply(int $status,array $data): never {
    http_response_code($status);echo json_encode($data,JSON_UNESCAPED_UNICODE|JSON_INVALID_UTF8_SUBSTITUTE);exit;
}
$db=null;
try {
    $method=$_SERVER['REQUEST_METHOD']??'';
    if (!in_array($method,['GET','POST'],true)) {header('Allow: GET, POST');reply(405,['error'=>'method_not_allowed']);}
    $event=null;
    if ($method==='POST') {
        $expected=getenv('VISITOR_STATS_ORIGIN')?:'https://'.($_SERVER['SERVER_NAME']??'');
        if (($_SERVER['HTTP_ORIGIN']??'')!==$expected) reply(403,['error'=>'origin_not_allowed']);
        if (strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))!=='application/json') reply(415,['error'=>'json_required']);
        if (!ctype_digit((string)($_SERVER['CONTENT_LENGTH']??''))||(int)$_SERVER['CONTENT_LENGTH']>2048) reply(413,['error'=>'request_too_large']);
        $event=json_decode(file_get_contents('php://input',false,null,0,2049)?:'',true);
        if (!is_array($event)||!in_array($event['event']??null,['page','song'],true)) reply(400,['error'=>'invalid_event']);
        if (isset($event['id'])&&(!is_string($event['id'])||!preg_match('/^[A-Za-z0-9_-]{8,80}$/D',$event['id']))) reply(400,['error'=>'invalid_id']);
        if ($event['event']==='song'&&(!is_string($event['song']??null)||strlen($event['song'])>512
            ||!is_string($event['chart']??null)||strlen($event['chart'])>32)) reply(400,['error'=>'invalid_song']);
    }
    $root=getenv('VISITOR_STATS_ROOT')?:__DIR__;$db=visitor_db($root);
    if ($event!==null) {
        $now=time();$ip=$_SERVER['REMOTE_ADDR']??'';
        if (!filter_var($ip,FILTER_VALIDATE_IP)) throw new RuntimeException('Client address unavailable');
        $song=null;$title=null;$chart=null;
        if ($event['event']==='song') {
            $catalog=getenv('VISITOR_STATS_CATALOG')?:dirname($root).'/data/library.json';
            $row=visitor_catalog($db,$catalog,$event['song'],$event['chart']);
            if (!$row) reply(422,['error'=>'unknown_chart']);
            $song=$event['song'];$title=$row['title'];$chart=$event['chart'];
        }
        $secret=visitor_secret($root);$eventId=$event['id']??bin2hex(random_bytes(16));
        $cookie=$_COOKIE['jv_visitor']??'';$parts=is_string($cookie)?explode('.',$cookie):[];
        if (count($parts)!==2||!preg_match('/^[a-f0-9]{32}$/D',$parts[0])
            ||!hash_equals(hash_hmac('sha256',$parts[0],$secret),$parts[1])) {
            // An initial response lost before Set-Cookie can retry without inventing another visitor.
            $token=substr(hash_hmac('sha256','visitor:'.$eventId,$secret),0,32);
            $cookie=$token.'.'.hash_hmac('sha256',$token,$secret);
            setcookie('jv_visitor',$cookie,['expires'=>$now+31536000,'path'=>'/','secure'=>true,'httponly'=>true,'samesite'=>'Lax']);
        } else $token=$parts[0];
        $visitor=hash('sha256',$token);$bucket=intdiv($now,60);
        $db->exec('BEGIN IMMEDIATE');
        $q=$db->prepare('INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END,bucket=excluded.bucket');
        $q->execute([hash('sha256',$ip),$bucket]);
        $q=$db->prepare('SELECT hits FROM rate_limits WHERE ip=?');$q->execute([hash('sha256',$ip)]);
        if ((int)$q->fetchColumn()>120) {$db->exec('COMMIT');header('Retry-After: 60');reply(429,['error'=>'rate_limited']);}
        $db->exec('DELETE FROM rate_limits WHERE bucket < '.($bucket-2));
        $q=$db->prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)');$q->execute([$eventId,$now]);
        if ($q->rowCount()) {
            $q=$db->prepare('INSERT OR IGNORE INTO visitors(id) VALUES(?)');$q->execute([$visitor]);
            if ($q->rowCount()) $db->exec('UPDATE counters SET visitors=visitors+1 WHERE id=1');
            $key=hash('sha256',json_encode([$event['event'],$song,$chart]));
            $q=$db->prepare('SELECT last_key,last_at FROM visitors WHERE id=?');$q->execute([$visitor]);$previous=$q->fetch(PDO::FETCH_ASSOC);
            if ($previous['last_key']!==$key||$now-(int)$previous['last_at']>=10) {
                $entry=['time'=>gmdate('c',$now),'event'=>$event['event'],'event_id'=>$eventId,'visitor'=>substr($visitor,0,16),
                    'ip'=>$ip,'song'=>$song,'title'=>$title,'chart'=>$chart,'ua'=>substr($_SERVER['HTTP_USER_AGENT']??'',0,1024)];
                $payload=json_encode($entry,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
                if (strlen($payload)>32767) throw new RuntimeException('Log record too large');
                $q=$db->prepare('INSERT INTO events(id,at,day,payload) VALUES(?,?,?,?)');$q->execute([$eventId,$now,gmdate('Y-m-d',$now),$payload]);
                $q=$db->prepare('UPDATE visitors SET last_key=?,last_at=? WHERE id=?');$q->execute([$key,$now,$visitor]);
                if ($event['event']==='page') $db->exec('UPDATE counters SET views=views+1 WHERE id=1');
            }
        }
        $db->exec('COMMIT');
        try {visitor_export($db,$root);} catch (Throwable $error) {error_log('[visitor-stats] export pending: '.get_class($error));}
    }
    $counts=$db->query('SELECT visitors,views FROM counters WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    reply(200,['visitors'=>(int)$counts['visitors'],'views'=>(int)$counts['views']]);
} catch (Throwable $error) {
    if ($db instanceof PDO) {try {$db->exec('ROLLBACK');} catch (Throwable $ignored) {}}
    error_log('[visitor-stats] '.get_class($error));reply(503,['error'=>'statistics_unavailable']);
}
