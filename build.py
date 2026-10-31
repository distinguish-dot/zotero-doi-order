"""Build an installable Zotero XPI from the three original addon files."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

root = Path(__file__).parent
manifest = json.loads((root / 'addon/manifest.json').read_text(encoding='utf-8'))
files = ['manifest.json', 'bootstrap.js', 'order-book.js']
output = root / 'dist' / f'zotero-doi-list-order-{manifest["version"]}.xpi'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for name in files:
        info = ZipInfo(name, date_time=(2026, 10, 21, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, (root / 'addon' / name).read_bytes())
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert sorted(archive.namelist()) == sorted(files)
    assert json.loads(archive.read('manifest.json')) == manifest
    for name in files:
        assert archive.read(name) == (root / 'addon' / name).read_bytes()
print(output.resolve())
print('SHA-256:', hashlib.sha256(output.read_bytes()).hexdigest())
