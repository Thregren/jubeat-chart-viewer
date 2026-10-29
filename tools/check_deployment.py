"""Read-only post-publication checks; never send visitor events or fetch private bodies."""
import argparse,json,re,sys
import urllib.request,urllib.error,urllib.parse

def inspect(base):
    parsed=urllib.parse.urlsplit(base)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('HTTPS origin required')
    base=urllib.parse.urlunsplit((parsed.scheme,parsed.netloc,'/','',''))
    def request(relative,method='GET'):
        req=urllib.request.Request(urllib.parse.urljoin(base,relative),method=method,headers={'User-Agent':'JubeatDeploymentCheck'})
        try:response=urllib.request.urlopen(req,timeout=10)
        except urllib.error.HTTPError as error:response=error
        with response:
            data=response.read(1024*1024) if method=='GET' else b''
            return response.status,{k.lower():v for k,v in response.headers.items()},data
    failures=[]
    def check(name,ok):
        if not ok:failures.append(name)
    status,headers,html=request('')
    check('homepage',status==200)
    policy=headers.get('content-security-policy','')
    check('strict CSP',"script-src 'self'" in policy and "object-src 'none'" in policy and 'unsafe-inline' not in policy and 'unsafe-eval' not in policy)
    check('HSTS',bool(headers.get('strict-transport-security')))
    check('nosniff',headers.get('x-content-type-options')=='nosniff')
    check('HTML revalidation',any(x in headers.get('cache-control','') for x in ['no-cache','no-store','must-revalidate']))
    match=re.search(rb'src="(static/[^"?]+\.[a-f0-9]{20}\.js)(?:\?[^\"]*)?"',html)
    check('hashed frontend',match is not None)
    if match:
        status,asset,_=request(match[1].decode(),'HEAD');check('immutable frontend',status==200 and 'immutable' in asset.get('cache-control',''))
    status,_,body=request('static/release.json')
    check('small release metadata',status==200 and len(body)<4096 and isinstance(json.loads(body).get('version'),str))
    for relative in ['.git/config','.env','.visitor-private/','.visitor-private/secret','.visitor-private/visitors.sqlite','%2evisitor-private/secret']:
        check('protected '+relative,request(relative,'HEAD')[0]==404)
    status,stats,body=request('api/visitors')
    check('aggregate statistics only',status==200 and set(json.loads(body))=={'visitors','today_visitors','views'})
    check('statistics not cached','no-store' in stats.get('cache-control',''))
    return dict(ok=not failures,failures=failures)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--url',required=True);args=parser.parse_args()
    try:result=inspect(args.url)
    except Exception as error:result=dict(ok=False,error=type(error).__name__)
    print(json.dumps(result));sys.exit(0 if result['ok'] else 1)
