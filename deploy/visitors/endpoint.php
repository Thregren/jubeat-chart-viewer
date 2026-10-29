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
function event_code(mixed $value,string $name): ?string {
    if ($value===null) return null;
    if (!is_string($value)||!preg_match('/^[a-z][a-z0-9_]{0,31}$/D',$value)) throw new InvalidArgumentException($name);
    return $value;
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
        $eventTypes=['page','song','app_ready','library_ready','library_error','chart_ready','chart_error',
            'audio_ready','audio_error','play_start','play_25','play_75','play_complete','play_error',
            'share_open','share_complete'];
        if (!is_array($event)||!in_array($event['event']??null,$eventTypes,true)) reply(400,['error'=>'invalid_event']);
        if (isset($event['id'])&&(!is_string($event['id'])||!preg_match('/^[A-Za-z0-9_-]{8,80}$/D',$event['id']))) reply(400,['error'=>'invalid_id']);
        if (isset($event['song'])&&(!is_string($event['song'])||strlen($event['song'])>512)) reply(400,['error'=>'invalid_song']);
        if (isset($event['chart'])&&(!is_string($event['chart'])||strlen($event['chart'])>32)) reply(400,['error'=>'invalid_song']);
        if ($event['event']==='song'&&(!is_string($event['song']??null)||!is_string($event['chart']??null))) reply(400,['error'=>'invalid_song']);
        if (isset($event['bucket'])&&!in_array($event['bucket'],['lt500','lt1500','lt4000','gte4000'],true)) reply(400,['error'=>'invalid_bucket']);
        try {
            $code=event_code($event['code']??null,'invalid_code');
        } catch (InvalidArgumentException) {
            reply(400,['error'=>'invalid_code']);
        }
        $bucket=$event['bucket']??null;
    }
    $root=getenv('VISITOR_STATS_ROOT')?:__DIR__;$db=visitor_db($root);
    if ($event!==null) {
        $now=time();$ip=$_SERVER['REMOTE_ADDR']??'';
        if (!filter_var($ip,FILTER_VALIDATE_IP)) throw new RuntimeException('Client address unavailable');
        if (!visitor_admit($db,$ip,$now)) {header('Retry-After: 60');reply(429,['error'=>'rate_limited']);}
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
            setcookie('jv_visitor',$cookie,['expires'=>$now+15552000,'path'=>'/','secure'=>true,'httponly'=>true,'samesite'=>'Lax']);
        } else $token=$parts[0];
        $visitor=hash('sha256',$token);
        $db->exec('BEGIN IMMEDIATE');
        $q=$db->prepare('SELECT 1 FROM receipts WHERE id=?');$q->execute([$eventId]);
        if ($q->fetchColumn()) {
            $db->exec('COMMIT');
            $counts=$db->query('SELECT visitors,views FROM counters WHERE id=1')->fetch(PDO::FETCH_ASSOC);
            reply(200,['visitors'=>(int)$counts['visitors'],'today_visitors'=>visitor_today($db,time()),
                'views'=>(int)$counts['views'],'popular_songs'=>visitor_popular($db,time())]);
        }
        if (!visitor_admit_cookie($db,$visitor,$now)) {
            $db->exec('COMMIT');header('Retry-After: 3600');
            reply(429,['error'=>'visitor_rate_limited']);
        }
        $q=$db->prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)');$q->execute([$eventId,$now]);
        if ($q->rowCount()) {
            $q=$db->prepare('INSERT OR IGNORE INTO visitors(id) VALUES(?)');$q->execute([$visitor]);
            if ($q->rowCount()) $db->exec('UPDATE counters SET visitors=visitors+1 WHERE id=1');
            $q=$db->prepare('UPDATE visitors SET last_seen=MAX(COALESCE(last_seen,0),?) WHERE id=?');$q->execute([$now,$visitor]);
            $key=hash('sha256',json_encode([$event['event'],$song,$chart,$bucket,$code]));
            $q=$db->prepare('SELECT last_key,last_at FROM visitors WHERE id=?');$q->execute([$visitor]);$previous=$q->fetch(PDO::FETCH_ASSOC);
            if ($previous['last_key']!==$key||$now-(int)$previous['last_at']>=10) {
                $entry=['time'=>gmdate('c',$now),'event'=>$event['event'],'event_id'=>$eventId,'visitor'=>substr($visitor,0,16),
                    'ip'=>$ip,'song'=>$song,'title'=>$title,'chart'=>$chart,'bucket'=>$bucket,'code'=>$code,
                    'ua'=>substr($_SERVER['HTTP_USER_AGENT']??'',0,1024)];
                $payload=json_encode($entry,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
                if (strlen($payload)>32767) throw new RuntimeException('Log record too large');
                $q=$db->prepare('INSERT INTO events(id,at,day,payload) VALUES(?,?,?,?)');$q->execute([$eventId,$now,gmdate('Y-m-d',$now),$payload]);
                if ($event['event']==='song') {
                    $ua=strtolower((string)($_SERVER['HTTP_USER_AGENT']??''));
                    $bot=preg_match('/headlesschrome|bot\\b|spider|crawler|playwright|puppeteer|jubeatdeploymentcheck|jubeatstatsqa|statsqa|python-requests|python-urllib|curl\\//',$ua)?1:0;
                    $q=$db->prepare('INSERT OR IGNORE INTO song_events(event_id,at,song,title,chart,bot) VALUES(?,?,?,?,?,?)');
                    $q->execute([$eventId,$now,$song,$title,$chart,$bot]);
                }
                $q=$db->prepare('UPDATE visitors SET last_key=?,last_at=? WHERE id=?');$q->execute([$key,$now,$visitor]);
                if ($event['event']==='page') $db->exec('UPDATE counters SET views=views+1 WHERE id=1');
            }
        }
        $db->exec('COMMIT');
        try {visitor_export($db,$root);} catch (Throwable $error) {error_log('[visitor-stats] export pending: '.get_class($error));}
    }
    $counts=$db->query('SELECT visitors,views FROM counters WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    reply(200,['visitors'=>(int)$counts['visitors'],'today_visitors'=>visitor_today($db,time()),
        'views'=>(int)$counts['views'],'popular_songs'=>visitor_popular($db,time())]);
} catch (Throwable $error) {
    if ($db instanceof PDO) {try {$db->exec('ROLLBACK');} catch (Throwable $ignored) {}}
    error_log('[visitor-stats] '.get_class($error));reply(503,['error'=>'statistics_unavailable']);
}
