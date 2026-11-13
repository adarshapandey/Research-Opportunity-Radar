"""Pinned, checksum-verified CPU runtime. Nothing here is served to visitors."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'scripts/model-config.json').read_text())
CACHE = ROOT / '.cache/local-model'


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def download(url, path, expected):
    if path.exists() and digest(path) == expected:
        return
    temporary = path.with_suffix('.download')
    print(f'Downloading {path.name} (first setup only)...', flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if digest(temporary) != expected:
        raise RuntimeError(f'Checksum mismatch: {path.name}')
    temporary.replace(path)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    model = Path(os.environ.get('RADAR_MODEL_PATH', CACHE / 'model.gguf')).resolve()
    runtime = os.environ.get('RADAR_LLAMA_CLI')
    if sys.argv[1:] == ['setup']:
        if not runtime:
            if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
                raise RuntimeError('Bundled runtime supports Linux x64. Install llama.cpp and set RADAR_LLAMA_CLI on other platforms.')
            archive = CACHE / 'llama-b6000.zip'
            download(CONFIG['runtime_url'], archive, CONFIG['runtime_sha256'])
            with zipfile.ZipFile(archive) as bundle:
                # The pinned archive is trusted only after checksum validation.
                bundle.extractall(CACHE / 'runtime')
            for binary in (CACHE / 'runtime').rglob('llama-*'):
                if binary.is_file():
                    binary.chmod(0o755)
        if 'RADAR_MODEL_PATH' not in os.environ:
            download(CONFIG['model_url'], model, CONFIG['model_sha256'])
        if not model.exists():
            raise RuntimeError(f'Model not found: {model}')
        print(f'Ready: {CONFIG["id"]}. Model remains outside the public site.')
        return
    raise RuntimeError('Usage: python3 scripts/local_runtime.py setup')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
