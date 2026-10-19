"""Run the real relocation shell script against temporary clones and fake services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parent.parent
node = shutil.which('node')
with tempfile.TemporaryDirectory(prefix='addons-relocate-test-') as temp:
    for mode in ['ok', 'manifest-drift', 'start-failure', 'target-exists']:
        state = Path(temp) / mode
        state.mkdir()
        old, new = state / 'old', state / 'new'
        subprocess.run(['git', 'clone', '--shared', '--quiet', str(source), str(old)], check=True)
        subprocess.run(['git', '-C', str(old), 'checkout', '--quiet', '-B', 'Master'], check=True)
        subprocess.run(['git', '-C', str(old), 'remote', 'set-url', 'origin', 'https://github.com/CaseyCZ/stremio.addons.git'], check=True)
        if mode == 'target-exists':
            new.mkdir()
        script = state / 'relocate.sh'
        script.write_text((source / 'relocate-addons-runtime.sh').read_text()
                          .replace('OLD=/home/ubuntu/stremio.sktonline', 'OLD=' + str(old))
                          .replace('NEW=/home/ubuntu/stremio.addons', 'NEW=' + str(new))
                          .replace('/tmp/stremio-sktonline-auto-deploy.lock', str(state / 'lock')))
        bindir = state / 'bin'
        bindir.mkdir()
        programs = {
            'npm': '#!/usr/bin/env bash\nexit 0\n',
            'sudo': '#!/usr/bin/env bash\n[[ "$*" == "-n true" ]]\n',
            'sleep': '#!/usr/bin/env bash\nexit 0\n',
            'pm2': '''#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
p=Path(os.environ['RELOCATE_TEST_STATE']);cmd=sys.argv[1]
with (p/'calls').open('a') as f:f.write(cmd+'\\n')
if cmd=='jlist':
 root=p/('new' if (p/'using-new').exists() else 'old')
 print(json.dumps([{'name':name,'pm2_env':{'status':'online','pm_exec_path':str(root)+tail,'pm_cwd':str(root)+cwd}} for name,tail,cwd in [('stremio-sktonline','/addon.js',''),('stremio-bombuj','/providers/bombuj/preflight-front.js','/providers/bombuj')]]))
elif cmd=='start':
 new='/new/' in sys.argv[2]
 if new and os.environ['RELOCATE_TEST_MODE']=='start-failure':sys.exit(1)
 if new:(p/'using-new').touch()
 elif (p/'using-new').exists():(p/'using-new').unlink()
''',
            'curl': '''#!/usr/bin/env python3
import os,json
from pathlib import Path
p=Path(os.environ['RELOCATE_TEST_STATE'])
changed=os.environ['RELOCATE_TEST_MODE']=='manifest-drift' and (p/'using-new').exists()
print(json.dumps({'id':'wrong' if changed else 'unchanged','version':'1','catalogs':[{'type':'movie','id':'unchanged'}]}))
'''
        }
        for name, content in programs.items():
            file = bindir / name
            file.write_text(content)
            file.chmod(0o755)
        env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'],
                   RELOCATE_TEST_STATE=str(state), RELOCATE_TEST_MODE=mode)
        result = subprocess.run(['bash', str(script)], env=env, capture_output=True, text=True, timeout=20)
        calls = (state / 'calls').read_text().splitlines() if (state / 'calls').exists() else []
        if mode == 'ok':
            assert result.returncode == 0 and new.is_dir() and not old.exists(), result.stderr
            assert calls.count('stop') == 2 and calls.count('start') == 2
            assert 'save' in calls
        elif mode == 'target-exists':
            assert result.returncode != 0 and old.is_dir() and 'stop' not in calls
        else:
            assert result.returncode != 0 and old.is_dir() and not new.exists(), result.stderr
            assert not (state / 'using-new').exists()
            assert 'save' in calls
        print(json.dumps({'case': mode, 'passed': True, 'exit': result.returncode}))
