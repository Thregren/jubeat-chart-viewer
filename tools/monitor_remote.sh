#!/bin/sh
# Read-only origin resource/log summary; run through existing TAT.
python3 - <<'PYREMOTE'
import collections,datetime,json,os,pathlib,shutil,subprocess
usage=shutil.disk_usage('/www');statuses=collections.Counter();bandwidth=0
p=pathlib.Path('/www/wwwlogs/ub.thregren.world.log')
if p.exists():
    with p.open('rb') as f:
        f.seek(max(0,p.stat().st_size-300000)); lines=f.read().decode('utf-8','replace').splitlines()[-1000:]
    for line in lines:
        try:
            fields=line.split('"')[2].split();statuses[fields[0]]+=1
            if fields[1]!='-':bandwidth+=int(fields[1])
        except (IndexError,ValueError):pass
cert=subprocess.check_output(['openssl','x509','-in','/www/server/panel/vhost/cert/ub.thregren.world/fullchain.pem','-noout','-enddate'],text=True).strip().split('=',1)[1]
expires=datetime.datetime.strptime(cert,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
print(json.dumps({'disk_used_percent':round(100*usage.used/usage.total,1),'disk_free_gib':round(usage.free/1024**3,2),'load_average':os.getloadavg(),'origin_tls_days_left':round((expires-datetime.datetime.now(datetime.timezone.utc)).total_seconds()/86400,1),'reboot_required':pathlib.Path('/var/run/reboot-required').exists(),'sample_requests':sum(statuses.values()),'sample_statuses':dict(statuses),'sample_response_bytes':bandwidth}))
PYREMOTE
