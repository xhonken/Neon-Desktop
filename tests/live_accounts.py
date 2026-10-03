"""Root-only real installed PAM/account/security acceptance with disposable accounts.
Usage: python live_accounts.py HTTPS_ORIGIN [CA_FILE]. No secrets persisted.
"""
import asyncio,grp,json,os,pwd,secrets,ssl,subprocess,sys
from pathlib import Path
import aiohttp

async def main():
    origin=sys.argv[1]
    sslctx=ssl.create_default_context(cafile=sys.argv[2] if len(sys.argv)>2 else None)
    admin='neon-admin-'+secrets.token_hex(3);user='neon-user-'+secrets.token_hex(3)
    password=secrets.token_urlsafe(24);initial=secrets.token_urlsafe(24);updated=secrets.token_urlsafe(24)
    sessions=[];created=[user]
    async def client(name,password):
        c=aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=sslctx),cookie_jar=aiohttp.CookieJar(unsafe=True),headers={'Origin':origin,'User-Agent':'Neon acceptance browser'})
        sessions.append(c)
        async with c.post(origin+'/api/v1/login',json={'username':name,'password':password}) as r:
            assert r.status==200,('login',r.status);csrf=(await r.json())['csrf']
        c.headers['X-CSRF-Token']=csrf
        return c
    async def request(c,path,payload=None,expected=200):
        async with c.request('POST' if payload is not None else 'GET',origin+'/api/v1/'+path,json=payload) as r:
            raw=await r.text()
            assert r.status==expected,(path,r.status,raw[:300])
            return json.loads(raw) if raw.startswith('{') else {}
    subprocess.run(['useradd','-m','-s','/bin/bash','-G','sudo',admin],check=True);created.append(admin)
    subprocess.run(['chpasswd'],input=admin+':'+password+'\n',text=True,check=True)
    os.chmod(pwd.getpwnam(admin).pw_dir,0o700)
    try:
        a=await client(admin,password)
        await request(a,'administration',{'operation':'create','username':user,'password':'incorrect','newPassword':initial},403)
        try:pwd.getpwnam(user);raise AssertionError('Failed authentication created an account')
        except KeyError:pass
        await request(a,'administration',{'operation':'create','username':user,'password':password,'newPassword':initial})
        u=pwd.getpwnam(user);assert 'sudo' not in subprocess.check_output(['id','-nG',user],text=True).split();assert Path(u.pw_dir).stat().st_mode&0o777==0o700
        c=await client(user,initial)
        await request(c,'administration',{'operation':'list'},403)
        me=await request(c,'me');assert not me['administrator'];assert 'org.neon.administration' not in [x['id'] for x in me['apps']]
        await request(a,'administration',{'operation':'lock','username':admin,'password':password},400)
        await request(a,'administration',{'operation':'sudo.grant','username':'root','password':password},400)
        await request(a,'administration',{'operation':'sudo.grant','username':user,'password':password})
        assert 'sudo' in subprocess.check_output(['id','-nG',user],text=True).split()
        await request(c,'administration',{'operation':'list'})
        await request(a,'administration',{'operation':'sudo.revoke','username':user,'password':password})
        await request(c,'administration',{'operation':'list'},403)
        async def rpc(action,**kw):return await request(c,'rpc',{'app':'org.neon.files','action':action,**kw})
        await rpc('files.mkdir',path='folder');await rpc('files.write',path='folder/file.txt',data='aGVsbG8=',exclusive=True)
        usage=await request(a,'administration',{'operation':'usage','username':user});assert usage['bytes']>0
        async def operation(kind,entries,expected='completed'):
            task=await rpc('files.operation.start',kind=kind,entries=entries)
            for _ in range(100):
                state=await rpc('files.operation.status',id=task['id'])
                if state['status']!='running':assert state['status']==expected,state;return state
                await asyncio.sleep(.05)
            raise AssertionError('File operation timeout')
        await operation('copy',[{'path':'folder','target':'copy'}]);assert (Path(u.pw_dir)/'copy/file.txt').read_text()=='hello'
        await operation('trash',[{'path':'folder'}]);trash=(await rpc('files.trash.list'))['entries'];assert len(trash)==1
        await rpc('files.mkdir',path='folder')
        await operation('restore',[{'id':trash[0]['id']}],expected='failed')
        await operation('restore',[{'id':trash[0]['id'],'target':'restored'}]);assert (Path(u.pw_dir)/'restored/file.txt').read_text()=='hello'
        await operation('trash',[{'path':'restored'}]);trash=(await rpc('files.trash.list'))['entries'];await operation('purge',[{'id':trash[0]['id']}]);assert not (await rpc('files.trash.list'))['entries']
        print('PASS ordinary account/HOME700/no default sudo, admin denial, reauthentication, protected self/root, explicit sudo grant/revoke, usage and file/trash lifecycle')
        terminal=await request(c,'rpc',{'app':'org.neon.terminal','action':'terminal.create'})
        before=(await request(c,'rpc',{'app':'org.neon.terminal','action':'terminal.list'}))['terminals']
        terminal_pid=next(x['pid'] for x in before if x['id']==terminal['id'])
        await request(a,'administration',{'operation':'lock','username':user,'password':password})
        await request(c,'me',expected=401)
        await request(a,'administration',{'operation':'reset','username':user,'password':password,'newPassword':updated})
        row=next(x.split(':') for x in Path('/etc/shadow').read_text().splitlines() if x.startswith(user+':'));assert row[1].startswith('!') and row[7]=='1'
        await request(a,'administration',{'operation':'unlock','username':user,'password':password})
        c=await client(user,updated);other=await client(user,updated)
        sec=await request(other,'security');sid=next(x['id'] for x in sec['sessions'] if x['current']);assert any(x['device']=='Neon acceptance browser' for x in sec['sessions'])
        # A user cannot revoke another user's session by supplying its ID.
        await request(a,'security',{'id':sid});await request(other,'me')
        await request(c,'security',{'id':sid});await request(other,'me',expected=401);await request(c,'me')
        await request(c,'account',{'operation':'password','username':'root','password':updated,'newPassword':initial})
        await request(c,'me',expected=401)
        c=await client(user,initial)
        assert (await request(c,'me'))['uid']==u.pw_uid
        visible=(await request(c,'security'))['sessions']
        assert len(visible)==1 and visible[0]['current'], 'Old invalid logins remain visible'
        after=(await request(c,'rpc',{'app':'org.neon.terminal','action':'terminal.list'}))['terminals']
        assert any(x['id']==terminal['id'] and x['pid']==terminal_pid and x['alive'] for x in after)
        assert Path('/proc/'+str(terminal_pid)).stat().st_uid==u.pw_uid
        print('PASS same live terminal PID across lock/reset/unlock, browser revocation and own password change')
        print('PASS lock/reset-keeps-lock/unlock, per-browser revocation and ownership, password change PAM login and old-cookie revocation')
    finally:
        for c in sessions:await c.close()
        for name in reversed(created):
            try:uid=pwd.getpwnam(name).pw_uid
            except KeyError:continue
            units=subprocess.check_output(['systemctl','list-units','--all','--full','--plain','--no-legend','neon-worker*','neon-browser*'],text=True)
            for line in units.splitlines():
                unit=line.split()[0]
                if unit.endswith('@'+str(uid)+'.service'):subprocess.run(['systemctl','stop',unit],check=True)
            subprocess.run(['userdel','-r',name],check=True)
        print('Disposable acceptance accounts removed')
if __name__=='__main__':
    if os.geteuid()!=0:raise SystemExit('Run as root on a test host')
    asyncio.run(main())
