"""Exercise real PHP HTTP/cookie/SQLite behavior with isolated synthetic records."""
import argparse, concurrent.futures, http.client, json, os, pathlib, shutil, socket, subprocess, tempfile, time, sqlite3, hashlib
ROOT=pathlib.Path(__file__).resolve().parent.parent

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--php',default='php');args=ap.parse_args()
    with tempfile.TemporaryDirectory(prefix='jv-visitors-') as tmp:
        root=pathlib.Path(tmp);private=root/'private';private.mkdir();endpoint=root/'index.php';shutil.copy2(ROOT/'deploy/visitors/endpoint.php',endpoint)
        for helper in ['visitor-storage.php','visitor-catalog.php']:shutil.copy2(ROOT/'deploy/visitors'/helper,root/helper)
        catalog=root/'library.json';catalog.write_text(json.dumps({'songs':[{'id':'version/song.mcz','title':'Test Song','charts':[{'code':'EXT'}]}]}))
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        env=os.environ|{'VISITOR_STATS_ROOT':str(private),'VISITOR_STATS_ORIGIN':'https://viewer.test','VISITOR_STATS_CATALOG':str(catalog)}
        with (root/'php.log').open('wb') as log:
            process=subprocess.Popen([args.php,'-S',f'127.0.0.1:{port}','-t',str(root)],env=env,stdout=log,stderr=log)
            def request(event=None,cookie=None,origin='https://viewer.test',raw=None):
                c=http.client.HTTPConnection('127.0.0.1',port,timeout=8);headers={'User-Agent':'Fixture UA\t1','Origin':origin};body=None
                if event is not None or raw is not None:body=raw if raw is not None else json.dumps(event);headers['Content-Type']='application/json'
                if cookie:headers['Cookie']=cookie
                c.request('POST' if body is not None else 'GET','/index.php',body=body,headers=headers);r=c.getresponse();data=r.read();out=(r.status,dict(r.getheaders()),json.loads(data));c.close();return out
            try:
                for _ in range(100):
                    try:status,_,counts=request();break
                    except OSError:time.sleep(.05)
                assert status==200 and counts=={'visitors':0,'views':0}
                status,headers,counts=request({'event':'page'});assert status==200 and counts=={'visitors':1,'views':1},(status,counts)
                cookie=headers['Set-Cookie'].split(';')[0];assert all(k in headers['Set-Cookie'].lower() for k in ['secure','httponly','samesite=lax'])
                assert request({'event':'page'},cookie)[2]==counts
                assert request({'event':'song','song':'version/song.mcz','chart':'EXT'},cookie)[0]==200
                assert request({'event':'song','song':'version/song.mcz','chart':'EXT'},cookie)[0]==200
                assert request({'event':'page'},cookie,origin='https://foreign.test')[0]==403
                assert request({'event':'song','song':'../../secret','chart':'EXT'},cookie)[0]==422
                assert request({'event':'song','song':'version/song.mcz','chart':'NOPE'},cookie)[0]==422
                assert request(raw='x'*2049)[0]==413
                assert request(raw='not json')[0]==400
                assert request({'event':'page'},'jv_visitor=forged')[2]['visitors']==2
                logs=list(private.glob('visits-*.log'));assert len(logs)==1
                records=[json.loads(line) for line in logs[0].read_text().splitlines()];assert len(records)==3,records
                song=next(x for x in records if x['event']=='song');assert song['ip']=='127.0.0.1' and song['song']=='version/song.mcz' and song['title']=='Test Song' and song['chart']=='EXT' and song['ua']=='Fixture UA\t1'
                assert all('jv_visitor' not in json.dumps(x) for x in records)
                assert request()[2]=={'visitors':2,'views':2}
                # Concurrent distinct browsers never lose increments; service restarts preserve totals.
                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    results=list(pool.map(lambda _:request({'event':'page'}),range(12)))
                assert all(x[0]==200 for x in results);assert request()[2]['visitors']==14
                process.terminate();process.wait(timeout=5)
                process=subprocess.Popen([args.php,'-S',f'127.0.0.1:{port}','-t',str(root)],env=env,stdout=log,stderr=log)
                for _ in range(100):
                    try:counts=request()[2];break
                    except OSError:time.sleep(.05)
                assert counts['visitors']==14
                # The same event ID, including a lost first Set-Cookie, has one effect.
                event={'event':'page','id':'stable-retry-event-0001'}
                status,headers,retry_counts=request(event);assert status==200
                retry_cookie=headers['Set-Cookie'].split(';')[0]
                status,headers,duplicate_counts=request(event);assert status==200 and retry_counts==duplicate_counts
                assert headers['Set-Cookie'].split(';')[0]==retry_cookie
                before=hashlib.sha256((private/'visitors.sqlite').read_bytes()).digest()
                request();request()
                assert hashlib.sha256((private/'visitors.sqlite').read_bytes()).digest()==before
                # Replay after a crash between append and outbox acknowledgement; recover partial tails.
                with sqlite3.connect(private/'visitors.sqlite') as db:db.execute('UPDATE events SET exported=0')
                records_before=logs[0].read_bytes()
                with logs[0].open('ab') as file:file.write(b'{"partial":')
                maintenance=ROOT/'deploy/visitors/maintenance.php'
                result=subprocess.run([args.php,str(maintenance),'--root',str(private),'--flush'],capture_output=True,text=True)
                assert result.returncode==0,result.stderr
                assert logs[0].read_bytes()==records_before
                # Export failure leaves a durable event for the next flush, without changing counters twice.
                backup=logs[0].with_suffix('.saved');logs[0].rename(backup);logs[0].mkdir()
                status,_,after_failure=request({'event':'page','id':'pending-export-event-0002'})
                assert status==200 and after_failure['visitors']==retry_counts['visitors']+1
                with sqlite3.connect(private/'visitors.sqlite') as db:assert db.execute('SELECT count(*) FROM events WHERE exported=0').fetchone()[0]==1
                logs[0].rmdir();backup.rename(logs[0])
                result=subprocess.run([args.php,str(maintenance),'--root',str(private),'--flush'],capture_output=True,text=True)
                assert result.returncode==0,result.stderr
                with sqlite3.connect(private/'visitors.sqlite') as db:assert db.execute('SELECT count(*) FROM events WHERE exported=0').fetchone()[0]==0
                assert sum(json.loads(line).get('event_id')=='pending-export-event-0002' for line in logs[0].read_text().splitlines())==1
                expired=private/'visits-2000-01-01.log';expired.write_text('{}\n')
                result=subprocess.run([args.php,str(maintenance),'--root',str(private)],capture_output=True,text=True)
                assert result.returncode==0 and expired.exists()
                result=subprocess.run([args.php,str(maintenance),'--root',str(private),'--apply'],capture_output=True,text=True)
                assert result.returncode==0 and not expired.exists() and request()[2]==after_failure
                versions=root/'data/versions';versions.mkdir(parents=True)
                part=versions/'版本 (plus)+.json';part.write_text(json.dumps({'songs':[{'id':'directory/song','title':'Split Song','charts':[{'code':'ADV'}]}]}))
                catalog.write_text(json.dumps({'format':'jubeat-directory-v1','songs':[],'versionIndexes':['data/versions/版本 (plus)+.json','data/versions/missing.json']}))
                status,_,counts=request({'event':'song','song':'directory/song','chart':'ADV'},cookie);assert status==200 and counts['visitors']==after_failure['visitors'],(status,counts)
                missing=versions/'missing.json';missing.write_text(json.dumps({'songs':[{'id':'directory/added','title':'New Version','charts':[{'code':'EXT'}]}]}))
                assert request({'event':'song','song':'directory/added','chart':'EXT'},cookie)[0]==200
                # Unknown chart names consume quota before filesystem catalog work.
                # Corrupt the catalog after quota exhaustion: rejection must remain 429, not 503.
                before_limit=request()[2]
                for _ in range(121):
                    status,headers,_=request({'event':'song','song':'directory/not-installed','chart':'EXT'},cookie)
                    if status==429:break
                    assert status==422,status
                assert status==429 and headers['Retry-After']=='60'
                assert request()[2]==before_limit
                catalog.write_text(json.dumps({'songs':[],'versionIndexes':['../outside.json']}))
                assert request({'event':'song','song':'directory/song','chart':'ADV'},cookie)[0]==429
                with sqlite3.connect(private/'visitors.sqlite') as db:db.execute('UPDATE rate_limits SET bucket=0')
                assert request({'event':'song','song':'directory/song','chart':'ADV'},cookie)[0]==503
                # Upgrade an old counter database without resetting prior totals.
                legacy=root/'legacy';legacy.mkdir()
                with sqlite3.connect(legacy/'visitors.sqlite') as db:
                    db.execute('CREATE TABLE counters(id INTEGER PRIMARY KEY,visitors INTEGER,views INTEGER)')
                    db.execute('INSERT INTO counters VALUES(1,77,123)')
                code='require $argv[1]; $db=visitor_db($argv[2]); echo json_encode($db->query("SELECT visitors,views FROM counters WHERE id=1")->fetch(PDO::FETCH_ASSOC));'
                result=subprocess.run([args.php,'-r',code,str(ROOT/'deploy/visitors/visitor-storage.php'),str(legacy)],capture_output=True,text=True)
                assert result.returncode==0 and json.loads(result.stdout)=={'visitors':77,'views':123},result.stderr
                assert (private/'secret').stat().st_mode & 0o077==0 and logs[0].stat().st_mode & 0o077==0
                print('Visitor HTTP checks passed: deduplication, signed cookies, whitelist, origin, bounds, log fields, concurrency, persistence and private permissions.')
            finally:
                if process.poll() is None:process.terminate();process.wait(timeout=5)
if __name__=='__main__':main()
