"""Check archived diagram hashes, original receipts and local navigation links."""
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs/architecture'


def read_json(path):
    data = path.read_bytes()
    return json.loads(data.decode('utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'))


def check(condition, message):
    if not condition:
        raise SystemExit(message)


def check_hash(name, expected):
    path = DOCS / name
    check(path.is_file(), f'Missing file: {name}')
    check(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f'Hash differs: {name}')


def check_link(parent, url):
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return
    check((parent / unquote(parsed.path)).is_file(), f'Broken local link in {parent}: {url}')


class Links(HTMLParser):
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                check_link(DOCS, value)


def main():
    manifest = read_json(DOCS / 'delivery-manifest.json')
    check(len(manifest['diagrams']) == 4, 'Expected four diagrams')
    for diagram in manifest['diagrams']:
        spec_hash, html_hash = diagram['specificationSha256'], diagram['artifactSha256']
        check_hash(diagram['specification'], spec_hash)
        check_hash(diagram['artifact'], html_hash)
        receipt = read_json(DOCS / diagram['deliveryReceipt'])
        validation = receipt['validation']
        check(receipt['ok'] and validation['checksPassed'] == validation['checkCount'] == 9
              and validation['errors'] == validation['warnings'] == 0, 'Invalid delivery receipt')
        check(receipt['specification']['sha256'] == spec_hash and receipt['artifact']['sha256'] == html_hash,
              'Delivery hash mismatch')
        browser = read_json(DOCS / diagram['browserReceipt'])
        check(browser['ok'] and browser['status'] == 'pass' and browser['artifact']['sha256'] == html_hash,
              'Browser evidence mismatch')
        review = diagram['perceptualReview']
        check(review['status'] == 'pass' and review['artifactSha256'] == html_hash, 'Visual review mismatch')
        for screenshot in review['screenshots']:
            check_hash(screenshot['path'], screenshot['sha256'])
        contact_sheet = DOCS / (Path(diagram['artifact']).stem + '.visual-check.html')
        Links().feed(contact_sheet.read_text(encoding='utf-8'))
    Links().feed((DOCS / manifest['entryPoint']).read_text(encoding='utf-8'))
    for readme in (ROOT / 'README.md', DOCS / 'README.md'):
        for url in re.findall(r'\]\(([^)]+)\)', readme.read_text(encoding='utf-8')):
            check_link(readme.parent, url)
    print('PASS: 4 diagram hashes, delivery/browser/visual evidence, screenshots and README/index links.')


if __name__ == '__main__':
    main()
