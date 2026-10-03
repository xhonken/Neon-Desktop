"""Root-only disposable user test of real Secret Service encryption and isolation."""
import os, pathlib, pwd, secrets, shutil, subprocess, sys, tempfile
root=pathlib.Path(__file__).resolve().parents[1]
name='neon-key-'+secrets.token_hex(3)
other='neon-key-'+secrets.token_hex(3)
work=pathlib.Path(tempfile.mkdtemp(prefix='neon-keyring-check-'))
work.chmod(0o755)
(work/'scripts').mkdir(mode=0o755);(work/'neon').mkdir(mode=0o755)
(work/'scripts').chmod(0o755);(work/'neon').chmod(0o755)
for src,dest in [('scripts/coding-launch.py','scripts/coding-launch.py'),('neon/coding_apps.py','neon/coding_apps.py'),('neon/__init__.py','neon/__init__.py')]:
 shutil.copyfile(root/src,work/dest);(work/dest).chmod(0o644)
check=work/'check.py'
check.write_text('''import importlib.util,os,pathlib,secrets,subprocess,sys
os.umask(0o077)
spec=importlib.util.spec_from_file_location('launch',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
password=secrets.token_urlsafe(24)
m.getpass.getpass=lambda prompt:password
home=pathlib.Path.home();env=m.keyring(home,dict(os.environ))
secret='test-only-'+secrets.token_urlsafe(24)
subprocess.run(['/usr/bin/secret-tool','store','--label=Neon acceptance','service','neon-test'],input=secret.encode(),env=env,check=True,timeout=10)
r=subprocess.run(['/usr/bin/secret-tool','lookup','service','neon-test'],env=env,capture_output=True,text=True,check=True,timeout=10)
assert r.stdout.strip()==secret
files=list((home/'.local/share/neon-codex-keyring/keyrings').glob('*.keyring'));assert files
assert all(secret.encode() not in f.read_bytes() and password.encode() not in f.read_bytes() and f.stat().st_mode&0o077==0 for f in files)
reply=m.dbus(env,'/org/freedesktop/secrets','org.freedesktop.Secret.Service.Lock',"['/org/freedesktop/secrets/collection/login']");assert reply.returncode==0,reply.stderr
env=m.keyring(home,env)
r=subprocess.run(['/usr/bin/secret-tool','lookup','service','neon-test'],env=env,capture_output=True,text=True,check=True,timeout=10);assert r.stdout.strip()==secret
m.getpass.getpass=lambda prompt: (_ for _ in ()).throw(AssertionError('Already unlocked keyring asked again'))
m.keyring(home,env)
(home/'.codex').mkdir(mode=0o700)
env.update(CODEX_HOME=str(home/'.codex'),PATH='/opt/neon-node/bin:/usr/bin:/bin')
cli=['/opt/neon-coding-tools/current/node_modules/.bin/codex','-c','cli_auth_credentials_store="keyring"']
r=subprocess.run(cli+['login','--with-api-key'],input=secret.encode(),env=env,capture_output=True,timeout=15);assert r.returncode==0,r.stderr
r=subprocess.run(cli+['login','status'],env=env,capture_output=True,timeout=15);assert r.returncode==0
assert not (home/'.codex/auth.json').exists()
assert all(secret.encode() not in f.read_bytes() for f in files)
r=subprocess.run(cli+['logout'],env=env,capture_output=True,timeout=15);assert r.returncode==0
print('PASS real Codex CLI credential store roundtrip; no plaintext auth.json')
print('PASS encrypted on-disk keyring, lock/unlock, secret roundtrip and shared unlocked state')
''');check.chmod(0o644)
created=[]
try:
 for user in [name,other]:
  subprocess.run(['useradd','-m','-s','/bin/bash',user],check=True);created.append(user);os.chmod(pwd.getpwnam(user).pw_dir,0o700)
 subprocess.run(['runuser','-u',name,'--','python3',str(check),str(work/'scripts/coding-launch.py')],check=True,timeout=60)
 address='unix:path='+pwd.getpwnam(name).pw_dir+'/.cache/neon-codex-keyring/bus'
 r=subprocess.run(['runuser','-u',other,'--','gdbus','call','--address',address,'--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.ListNames'],capture_output=True,timeout=10)
 assert r.returncode!=0
 print('PASS second Linux account denied credential bus access')
finally:
 for user in reversed(created):
  subprocess.run(['pkill','-u',str(pwd.getpwnam(user).pw_uid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  subprocess.run(['userdel','-r',user],check=True)
 shutil.rmtree(work)
