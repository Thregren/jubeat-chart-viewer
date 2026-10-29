<?php
declare(strict_types=1);
// CLI only. Dry-run retention by default; never expose this file as an HTTP route.
if (PHP_SAPI!=='cli') {http_response_code(404);exit;}
umask(0077);require_once __DIR__.'/visitor-storage.php';
$options=getopt('',['root:','retention-days:','backup-dir:','backup-keep:','apply','flush']);
$root=$options['root']??getenv('VISITOR_STATS_ROOT');$days=filter_var($options['retention-days']??90,FILTER_VALIDATE_INT);
$backupDir=$options['backup-dir']??getenv('VISITOR_STATS_BACKUP_DIR');
$backupKeep=filter_var($options['backup-keep']??7,FILTER_VALIDATE_INT);
if (!$root||!$days||$days<7||$days>3650) {fwrite(STDERR,"Require --root and retention-days between 7 and 3650\n");exit(2);}
if ($backupKeep===false||$backupKeep<1||$backupKeep>90) {fwrite(STDERR,"backup-keep must be between 1 and 90\n");exit(2);}
private_file($root);
if (!is_file($root.'/visitors.sqlite')) {fwrite(STDERR,"Existing statistics storage required\n");exit(2);}
$db=visitor_db($root);
$flushed=isset($options['flush'])?visitor_export($db,$root,100):0;
$backup=$backupDir?visitor_backup($db,$root,$backupDir,(int)$backupKeep):null;
$cutoff=time()-$days*86400;$old=gmdate('Y-m-d',$cutoff);$files=[];$pendingDays=array_flip($db->query('SELECT DISTINCT day FROM events WHERE exported=0')->fetchAll(PDO::FETCH_COLUMN));
foreach (glob($root.'/visits-*.log') as $file) {
    private_file($file);
    if (preg_match('/^visits-(\d{4}-\d{2}-\d{2})\.log$/D',basename($file),$match)&&$match[1]<$old&&!isset($pendingDays[$match[1]])) $files[]=$file;
}
$q=$db->prepare('SELECT COUNT(*) FROM events WHERE exported=1 AND at<?');$q->execute([$cutoff]);$rows=(int)$q->fetchColumn();
if (isset($options['apply'])) {
    // Serialize with exporters, preserve pending events, cumulative counters and identities.
    private_file($root.'/export.lock');$lock=fopen($root.'/export.lock','c');
    if (!$lock||!flock($lock,LOCK_EX)) throw new RuntimeException('Maintenance lock unavailable');
    try {
        foreach ($files as $file) if (!unlink($file)) throw new RuntimeException('Retention failed');
        $q=$db->prepare('DELETE FROM events WHERE exported=1 AND at<?');$q->execute([$cutoff]);
        $q=$db->prepare('DELETE FROM song_events WHERE at<?');$q->execute([$cutoff]);
        $q=$db->prepare('DELETE FROM receipts WHERE at<? AND id NOT IN (SELECT id FROM events WHERE exported=0)');$q->execute([$cutoff]);
        $q=$db->prepare('DELETE FROM visitor_rate_limits WHERE bucket<?');$q->execute([intdiv($cutoff,3600)-2]);
        $db->exec('PRAGMA wal_checkpoint(PASSIVE)');
    } finally {flock($lock,LOCK_UN);fclose($lock);}
}
echo json_encode(['apply'=>isset($options['apply']),'retention_days'=>$days,'log_files'=>count($files),
    'exported_events'=>$rows,'flushed'=>$flushed,'backup'=>$backup],JSON_UNESCAPED_SLASHES)."\n";
