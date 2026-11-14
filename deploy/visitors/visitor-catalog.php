<?php
declare(strict_types=1);
function catalog_identity(string $path): array {
    clearstatcache(true,$path);$stat=stat($path);
    if (!$stat||$stat['size']>8*1024*1024) throw new RuntimeException('Invalid catalog file');
    return [$path,$stat['ino'],$stat['size'],$stat['mtime'],$stat['ctime']];
}
// An index listed by the catalog but absent on disk still has to take part in
// the signature: otherwise a version index that appears later is invisible to
// the stat-only fast path and its songs stay rejected as unknown forever.
function catalog_absent(string $path): array {
    return [$path,0,0,0,0];
}
function catalog_stat(string $path): array {
    return is_file($path)?catalog_identity($path):catalog_absent($path);
}
function catalog_json(string $path): array {
    $data=json_decode(file_get_contents($path),true,64,JSON_THROW_ON_ERROR);
    if (!is_array($data)||!is_array($data['songs']??null)) throw new RuntimeException('Invalid catalog');
    return $data;
}
// Rebuilds the cache signature from stat() only. Returns null whenever the
// cached source list cannot be trusted, which forces the full parse path.
function catalog_cached_signature($sources,array $first): ?string {
    if (!is_string($sources)) return null;
    $paths=json_decode($sources,true,4);
    if (!is_array($paths)||!$paths||count($paths)>257) return null;
    try {
        $identities=[];$bytes=0;
        foreach ($paths as $path) {
            if (!is_string($path)||strlen($path)>4096) return null;
            $identity=catalog_stat($path);
            $bytes+=$identity[2];
            if ($bytes>32*1024*1024) return null;
            $identities[]=$identity;
        }
        // A different spelling of the same index path is not worth a rebuild.
        if ($identities[0]!==$first) return null;
        return hash('sha256',json_encode($identities));
    } catch (Throwable $error) {return null;}
}
function visitor_catalog(PDO $db,string $catalog,string $song,string $chart): ?array {
    // Filesystem work happens before the short cache publication transaction.
    // Steady state only stats the index files: the multi-megabyte JSON is parsed
    // only when an (ino,size,mtime,ctime) identity actually changed.
    $first=catalog_identity($catalog);
    $cached=$db->query("SELECT key,value FROM meta WHERE key IN ('catalog','catalog:sources')")->fetchAll(PDO::FETCH_KEY_PAIR);
    $stored=$cached['catalog']??null;
    $signature=is_string($stored)?catalog_cached_signature($cached['catalog:sources']??null,$first):null;
    if ($signature===null||$signature!==$stored) {
        $data=catalog_json($catalog);
        $site=realpath(basename(dirname($catalog))==='data'?dirname($catalog,2):dirname($catalog));
        if (!$site) throw new RuntimeException('Catalog root unavailable');
        $sources=[$catalog];$listing=[$catalog];$identities=[$first];$identityOf=[$catalog=>$first];$bytes=$first[2];
        $indexes=$data['versionIndexes']??[];
        if (!is_array($indexes)||count($indexes)>256) throw new RuntimeException('Invalid version indexes');
        $seen=[];
        foreach ($indexes as $relative) {
            if (!is_string($relative)||strlen($relative)>512||isset($seen[$relative])
                ||!str_starts_with($relative,'data/versions/')||!str_ends_with($relative,'.json')
                ||preg_match('/[\\\\\x00-\x1f?#]/',$relative)||array_intersect(['','.','..'],explode('/',$relative)))
                throw new RuntimeException('Unsafe version index');
            $seen[$relative]=true;$path=$site.'/'.$relative;
            $resolved=file_exists($path)?realpath($path):null;
            if ($resolved===false) throw new RuntimeException('Escaped index');
            $entry=$resolved??$path;
            if (!str_starts_with($entry,$site.DIRECTORY_SEPARATOR)) throw new RuntimeException('Escaped index');
            // A missing index is part of the signature too, so that publishing
            // it later invalidates the cache instead of being ignored.
            $listing[]=$entry;
            if ($resolved===null) {$identities[]=catalog_absent($entry);continue;}
            $identity=catalog_identity($resolved);$bytes+=$identity[2];
            if ($bytes>32*1024*1024) throw new RuntimeException('Catalog budget exceeded');
            $sources[]=$resolved;$identities[]=$identity;$identityOf[$resolved]=$identity;
        }
        $signature=hash('sha256',json_encode($identities));
        if ($stored!==$signature) {
            $rows=[];
            foreach ($sources as $i=>$file) {
                $part=$i===0?$data:catalog_json($file);
                foreach ($part['songs'] as $item) {
                    if (!is_array($item)||!is_string($item['id']??null)||isset($rows[$item['id']])
                        ||!is_string($item['title']??null)||strlen($item['title'])>4096||!is_array($item['charts']??null)
                        ||count($item['charts'])>32||count($rows)>=50000) throw new RuntimeException('Invalid catalog song');
                    $rows[$item['id']]=[$item['id'],$item['title'],json_encode(array_column($item['charts'],'code'))];
                }
                if (catalog_identity($file)!==$identityOf[$file]) throw new RuntimeException('Catalog changed');
            }
            $db->exec('BEGIN IMMEDIATE');
            try {
                $db->exec('DELETE FROM catalog');$q=$db->prepare('INSERT INTO catalog VALUES(?,?,?)');
                foreach ($rows as $row) $q->execute($row);
                $q=$db->prepare("INSERT INTO meta VALUES('catalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");$q->execute([$signature]);
                $q=$db->prepare("INSERT INTO meta VALUES('catalog:sources',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
                $q->execute([json_encode($listing)]);
                $db->exec('COMMIT');
            } catch (Throwable $error) {$db->exec('ROLLBACK');throw $error;}
        } else {
            // The catalog rows are already current, but a database written before
            // catalog:sources existed has no stat-only source list. Publish it so
            // the next request can skip the JSON parse; failing to do so only
            // costs speed, never correctness.
            try {
                $q=$db->prepare("INSERT INTO meta VALUES('catalog:sources',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
                $q->execute([json_encode($listing)]);
            } catch (Throwable $ignored) {}
        }
    }
    $q=$db->prepare('SELECT title,charts FROM catalog WHERE id=?');$q->execute([$song]);$row=$q->fetch(PDO::FETCH_ASSOC);
    return $row&&in_array($chart,json_decode($row['charts'],true),true)?$row:null;
}
