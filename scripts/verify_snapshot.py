"""Verify the exported OMP snapshot without modifying local OMP configuration."""
import hashlib
import json
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / 'snapshot-manifest.json').read_text(encoding='utf-8'))
    records = manifest['files']
    expected = {record['path'] for record in records}
    if len(expected) != len(records) or len(records) != manifest['fileCount']:
        raise SystemExit('Invalid manifest file count or duplicate entries')
    actual = {p.relative_to(root).as_posix() for p in (root / 'omp').rglob('*') if p.is_file()}
    if actual != expected:
        raise SystemExit(f'File set differs: missing={sorted(expected-actual)}, extra={sorted(actual-expected)}')
    total = 0
    for record in records:
        file = root / record['path']
        if file.is_symlink() or not file.resolve().is_relative_to(root / 'omp'):
            raise SystemExit(f'Unsafe snapshot path: {record["path"]}')
        data = file.read_bytes()
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise SystemExit(f'Content differs: {record["path"]}')
        total += len(data)
    if total != manifest['totalBytes']:
        raise SystemExit('Manifest total size differs')
    print(f'PASS: {len(records)} files, {total} bytes, all SHA256 checks match.')


if __name__ == '__main__':
    main()
