from pathlib import Path
import subprocess

with open('/tmp/v263.py', 'wb') as out:
    subprocess.run([
        'git', 'show', '66f17a62ef19f4031ca08a3e5fe5f2da40b5200a:.github/v263_local_residual_patch.py'
    ], check=True, stdout=out)
subprocess.run(['python3', '/tmp/v263.py'], check=True)
