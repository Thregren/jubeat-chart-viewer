<?php
declare(strict_types=1);
function catalog_identity(string $path): array {
    clearstatcache(true,$path);$stat=stat($path);
    if (!$stat||$stat['size']>8*1024*1024) throw new RuntimeException('Invalid catalog file');
    return [$path,$stat['ino'],$stat['size'],$stat['mtime'],$stat['ctime']];
}
function catalog_json(string $path): array {
    $data=json_decode(file_get_contents($path),true,64,JSON_THROW_ON_ERROR);
    if (!is_array($data)||!is_array($data['songs']??null)) throw new RuntimeException('Invalid catalog');
    return $data;
}
function visitor_catalog(PDO $db,string $catalog,string $song,string $chart): ?array {
    // Filesystem work happens before the short cache publication transaction.
    $first=catalog_identity($catalog);$data=catalog_json($catalog);
    $site=realpath(basename(dirname($catalog))==='data'?dirname($catalog,2):dirname($catalog));
    if (!$site) throw new RuntimeException('Catalog root unavailable');
    $sources=[$catalog];$identities=[$first];$bytes=$first[2];
    $indexes=$data['versionIndexes']??[];
    if (!is_array($indexes)||count($indexes)>256) throw new RuntimeException('Invalid version indexes');
    $seen=[];
    foreach ($indexes as $relative) {
        if (!is_string($relative)||strlen($relative)>512||isset($seen[$relative])
            ||!str_starts_with($relative,'data/versions/')||!str_ends_with($relative,'.json')
            ||preg_match('/[\\\\\x00-\x1f?#]/',$relative)||array_intersect(['','.','..'],explode('/',$relative)))
            throw new RuntimeException('Unsafe version index');
        $seen[$relative]=true;$path=$site.'/'.$relative;
        if (!file_exists($path)) continue;
        $resolved=realpath($path);
        if (!$resolved||!str_starts_with($resolved,$site.DIRECTORY_SEPARATOR)) throw new RuntimeException('Escaped index');
        $identity=catalog_identity($resolved);$bytes+=$identity[2];
        if ($bytes>32*1024*1024) throw new RuntimeException('Catalog budget exceeded');
        $sources[]=$resolved;$identities[]=$identity;
    }
    $signature=hash('sha256',json_encode($identities));
    $current=$db->query("SELECT value FROM meta WHERE key='catalog'")->fetchColumn();
    if ($current!==$signature) {
        $rows=[];
        foreach ($sources as $i=>$file) {
            $part=$i===0?$data:catalog_json($file);
            foreach ($part['songs'] as $item) {
                if (!is_array($item)||!is_string($item['id']??null)||isset($rows[$item['id']])
                    ||!is_string($item['title']??null)||strlen($item['title'])>4096||!is_array($item['charts']??null)
                    ||count($item['charts'])>32||count($rows)>=50000) throw new RuntimeException('Invalid catalog song');
                $rows[$item['id']]=[$item['id'],$item['title'],json_encode(array_column($item['charts'],'code'))];
            }
            if (catalog_identity($file)!==$identities[$i]) throw new RuntimeException('Catalog changed');
        }
        $db->exec('BEGIN IMMEDIATE');
        try {
            $db->exec('DELETE FROM catalog');$q=$db->prepare('INSERT INTO catalog VALUES(?,?,?)');
            foreach ($rows as $row) $q->execute($row);
            $q=$db->prepare("INSERT INTO meta VALUES('catalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");$q->execute([$signature]);
            $db->exec('COMMIT');
        } catch (Throwable $error) {$db->exec('ROLLBACK');throw $error;}
    }
    $q=$db->prepare('SELECT title,charts FROM catalog WHERE id=?');$q->execute([$song]);$row=$q->fetch(PDO::FETCH_ASSOC);
    return $row&&in_array($chart,json_decode($row['charts'],true),true)?$row:null;
}
