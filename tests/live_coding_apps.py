"""Installed-host acceptance; disposable identities, no real API credentials."""
import json, os, pathlib, pwd, secrets, shutil, subprocess, sys, tempfile
root=pathlib.Path(__file__).resolve().parents[1]
controller=pwd.getpwnam(sys.argv[2]);users=[]
with tempfile.TemporaryDirectory(prefix='neon-coding-check-') as temp:
 os.chown(temp,controller.pw_uid,controller.pw_gid)
 try:
  for _ in range(2):
   name='neon-code-'+secrets.token_hex(3);password=secrets.token_urlsafe(24)
   subprocess.run(['useradd','-m','-s','/bin/bash',name],check=True)
   a=pwd.getpwnam(name);os.chmod(a.pw_dir,0o700)
   users.append(dict(name=name,password=password,uid=a.pw_uid))
   subprocess.run(['chpasswd'],input=name+':'+password+'\n',text=True,check=True)
  result=subprocess.run(['runuser','-u',controller.pw_name,'--','/opt/neon-node/bin/node',str(root/'scripts/coding-check.mjs')],input=json.dumps(dict(origin=sys.argv[1],users=users,keyring=secrets.token_urlsafe(24),output=temp))+'\n',text=True,capture_output=True,timeout=180,cwd=root)
  print(result.stdout);print(result.stderr,file=sys.stderr)
  if result.returncode:raise SystemExit(result.returncode)
  proof=json.loads(next(s for s in result.stdout.splitlines() if s.startswith('{')))
  proc=pathlib.Path('/proc')/str(proof['sessionPid'])
  assert proc.stat().st_uid==users[0]['uid']
  assert os.readlink(proc/'cwd')==pwd.getpwnam(users[0]['name']).pw_dir+'/Coding test with spaces'
  print('PASS actual Codex process UID and project cwd')
  out=pathlib.Path('/root/neon-coding-apps-20261003');out.mkdir(exist_ok=True,mode=0o700)
  for p in pathlib.Path(temp).glob('*.png'):shutil.copyfile(p,out/p.name)
 finally:
  for u in users:
   subprocess.run(['systemctl','stop',f"neon-worker-g*@{u['uid']}.service"],check=False)
   subprocess.run(['pkill','-KILL','-u',str(u['uid'])],check=False)
   subprocess.run(['userdel','-r',u['name']],check=False)
