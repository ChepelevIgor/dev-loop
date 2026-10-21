#!/usr/bin/env python3
"""Build an allowlisted, reproducible public plugin ZIP without uploading anything."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = ('plugin.json', 'README.md', 'PRIVACY.md', 'SUPPORT.md', 'requirements.txt')
TREES = ('skills', 'assets')
SUFFIXES = {'.md', '.py', '.sh', '.mjs', '.json', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.yaml', '.yml'}
EXPECTED_SKILLS = {'check-bug', 'close-threads', 'debate', 'start-task', 'filter-design', 'help', 'match-design', 'sim-verify-task'}
# Conservative credential signatures, not a claim to recognize every possible secret.
# Report only the rule and path; never include matched bytes in errors or audits.
CREDENTIAL_PATTERNS = {
    'private key': rb'-----BEGIN (?:[A-Z0-9]+ )?(?:PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----',
    'GitHub token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})',
    'Linear token': rb'\blin_(?:api|oauth)_[A-Za-z0-9_-]{20,}',
    'model API key': rb'\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}',
    'AWS access key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'Google API key': rb'\bAIza[A-Za-z0-9_-]{35}\b',
    'Slack token': rb'\bxox[baprs]-[A-Za-z0-9-]{20,}',
    'Stripe secret': rb'\b[rs]k_live_[A-Za-z0-9]{16,}',
    'SendGrid key': rb'\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}',
    'npm token': rb'\bnpm_[A-Za-z0-9]{30,}',
    'JWT': rb'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}',
    'credentials in URL': rb'(?i)(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/:@]+:[^\s/@]+@',
    'literal credential': rb'''(?i)\b[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|secret[_-]?key|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']''',
    'authorization value': rb'''(?i)\bauthorization["']?\s*[:=]\s*["'](?:Bearer |Basic )[A-Za-z0-9_./+=-]{16,}["']''',
}
CREDENTIAL_PATTERNS = {kind: re.compile(pattern) for kind, pattern in CREDENTIAL_PATTERNS.items()}


def files(root):
    result = [root/name for name in TOP_FILES]
    for tree in TREES:
        base = root/tree
        if base.is_symlink():
            raise ValueError(f'symlink is not allowed: {tree}')
        if not base.is_dir():
            raise ValueError(f'missing directory: {tree}')
        for path in base.rglob('*'):
            if path.is_symlink():
                raise ValueError(f'symlink is not allowed: {path.relative_to(root)}')
            if '__pycache__' in path.parts or path.suffix == '.pyc':
                continue
            if path.is_file():
                if path.suffix not in SUFFIXES or any(part.startswith('.') for part in path.relative_to(root).parts):
                    raise ValueError(f'unexpected packaged file: {path.relative_to(root)}')
                result.append(path)
    for path in result:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'missing/unsafe release file: {path.relative_to(root)}')
    return sorted(result, key=lambda path: path.relative_to(root).as_posix())


def public_url(value):
    if not isinstance(value, str) or len(value) > 1024:
        return False
    try:
        url = urlparse(value)
        host = (url.hostname or '').lower()
        return (url.scheme == 'https' and bool(host) and url.username is None and url.password is None
                and host not in {'localhost', 'example.com', 'example.org', 'example.net'}
                and '.' in host and not host.endswith(('.test', '.invalid', '.localhost', '.local')))
    except ValueError:
        return False


def inspect(root):
    errors, pending = [], []
    manifest = json.loads((root/'plugin.json').read_text())
    ext = manifest.get('extensions', {}).get('com.openai', {})
    ui = ext.get('interface', {})
    if manifest.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
        errors.append('portable manifest schema is missing')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', manifest.get('name', '')) or len(manifest.get('name', '')) > 64:
        errors.append('invalid plugin name')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?', manifest.get('version', '')):
        errors.append('explicit semantic version required')
    for obj, key, limit in [(manifest, 'description', 4000), (manifest.get('author', {}), 'name', 120),
                            (ui, 'displayName', 30), (ui, 'shortDescription', 30),
                            (ui, 'longDescription', 4000), (ui, 'developerName', 80), (ui, 'category', 120)]:
        value = obj.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            errors.append(f'invalid/missing {key} (limit {limit})')
    if ext.get('requires_local_executor') is not True:
        errors.append('desktop execution must be declared')
    def forbidden(value):
        if isinstance(value, dict):
            return any(k in {'hooks', 'apps', 'mcpServers', 'test_credentials', 'reviewer_instructions'} or forbidden(v) for k,v in value.items())
        if isinstance(value, list):
            return any(forbidden(v) for v in value)
        return False
    if forbidden(manifest) or 'review' in ext:
        errors.append('skills-only public manifest must not contain hooks, apps, MCP or private review fields')
    prompts = ui.get('defaultPrompt', [])
    if not isinstance(prompts, list) or len(prompts) > 3 or any(not isinstance(p, str) or not p.strip() or len(p) > 128 or '@' in p for p in prompts):
        errors.append('starter prompts must be up to three unique strings of at most 128 characters without mentions')
    elif len(set(prompts)) != len(prompts):
        errors.append('starter prompts must be unique')
    for locale, translation in ext.get('publication', {}).get('translations', {}).items():
        for key, limit in [('subtitle', 30), ('description', 4000)]:
            if key in translation and (not isinstance(translation[key], str) or not translation[key].strip() or len(translation[key]) > limit):
                errors.append(f'invalid {locale} {key}')
    packaged = files(root)
    names = {p.relative_to(root).as_posix() for p in packaged}
    for key in ('logo', 'composerIcon', 'logoDark', 'composerIconDark'):
        value = ui.get(key)
        if key.endswith('Dark') and value is None:
            continue
        if not isinstance(value, str) or not value.startswith('./') or '..' in Path(value).parts or value[2:] not in names:
            errors.append(f'missing/unsafe {key}')
            continue
        path = root/value
        if path.stat().st_size > 5*1024*1024:
            errors.append(f'icon too large: {value}')
        if path.suffix == '.svg':
            try:
                svg = ET.parse(path).getroot()
                width, height = float(svg.attrib['width']), float(svg.attrib['height'])
                if width != height or width < 48:
                    raise ValueError('non-square or too small')
                for node in svg.iter():
                    if node.tag.rsplit('}', 1)[-1] in ('script', 'foreignObject') or any(k.startswith('on') or k.endswith('href') for k in node.attrib):
                        raise ValueError('active SVG content')
            except (ET.ParseError, KeyError, ValueError) as exc:
                errors.append(f'invalid SVG: {value}: {exc}')
        else:
            # Only our simple SVG assets are accepted by this project's builder.
            errors.append(f'unsupported project icon format: {value}')
    skills = []
    for path in sorted((root/'skills').glob('*/SKILL.md')):
        source = path.read_text()
        header = source.split('---', 2)[1] if source.startswith('---\n') else ''
        name = re.search(r'^name: ([a-z0-9-]+)$', header, re.M)
        description = re.search(r'^description: (.+)$', header, re.M)
        if not name or name.group(1) != path.parent.name or not description:
            errors.append(f'invalid skill header: {path.parent.name}')
        skills.append(path.parent.name)
    if set(skills) != EXPECTED_SKILLS:
        errors.append(f'expected {len(EXPECTED_SKILLS)} packaged skills: {", ".join(sorted(EXPECTED_SKILLS))}')
    for path in packaged:
        data = path.read_bytes()
        for kind, pattern in CREDENTIAL_PATTERNS.items():
            if pattern.search(data):
                errors.append(f'credential-like content ({kind}): {path.relative_to(root)}')
                break
        if re.search(rb'/(?:Users|home)/[^/\s]+/', data):
            errors.append(f'private development context: {path.relative_to(root)}')
    for key in ('websiteURL', 'supportURL', 'privacyPolicyURL'):
        if not public_url(ui.get(key)):
            pending.append(f'Publish and supply a real HTTPS {key}')
    publisher_file = root/'publication/publisher.json'
    publisher = json.loads(publisher_file.read_text()) if publisher_file.exists() else {}
    if publisher.get('publication_authorized') is not True:
        pending.append('Publisher authorization to distribute the package and publish its support/privacy pages is required')
    return manifest, packaged, errors, pending


def build(root=ROOT, out=None, draft=False, check_urls=False):
    root = Path(root).resolve()
    out = Path(out or root/'dist').resolve()
    manifest, packaged, errors, pending = inspect(root)
    url_results = {}
    if check_urls:
        ui = manifest['extensions']['com.openai']['interface']
        for key in ('websiteURL', 'supportURL', 'privacyPolicyURL'):
            value = ui.get(key)
            if not public_url(value):
                continue
            try:
                request = Request(value, headers={'User-Agent': 'DevLoop-Release-Preflight'})
                with urlopen(request, timeout=20) as response:
                    if not public_url(response.url):
                        raise ValueError('redirect target is not a valid public HTTPS URL')
                    url_results[key] = {'url': value, 'status': response.status, 'final_url': response.url}
            except Exception as exc:
                pending.append(f'{key} is not publicly reachable: {exc}')
    name = f"{manifest['name']}-{manifest['version']}" + ('-draft' if draft else '')
    out.mkdir(parents=True, exist_ok=True)
    audit = {'name':manifest['name'], 'version':manifest['version'], 'mode':'draft' if draft else 'ready',
             'package_errors':errors, 'publication_pending':pending, 'url_checks':url_results,
             'local_preflight_passed':not errors and not pending,
             'openai_review_status':'not_submitted', 'files':[]}
    if errors or (pending and not draft):
        (out/(name+'.audit.json')).write_text(json.dumps(audit, ensure_ascii=False, indent=2)+'\n')
        raise ValueError('\n'.join(errors + ([] if draft else pending)))
    archive = out/(name+'.zip')
    temp = out/(name+'.zip.tmp')
    try:
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zip:
            for path in packaged:
                relative = path.relative_to(root).as_posix()
                data = path.read_bytes()
                executable = bool(path.stat().st_mode & 0o111)
                info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = ((stat.S_IFREG | (0o755 if executable else 0o644)) << 16)
                info.compress_type = zipfile.ZIP_DEFLATED
                zip.writestr(info, data, compresslevel=9)
                audit['files'].append({'path':relative, 'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest(), 'executable':executable})
        with zipfile.ZipFile(temp) as zip:
            if zip.testzip() is not None:
                raise ValueError('ZIP integrity verification failed')
        temp.replace(archive)
    finally:
        temp.unlink(missing_ok=True)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    audit.update(archive=archive.name, sha256=digest, bytes=archive.stat().st_size)
    (out/(name+'.sha256')).write_text(f'{digest}  {archive.name}\n')
    (out/(name+'.audit.json')).write_text(json.dumps(audit, ensure_ascii=False, indent=2)+'\n')
    return archive, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT/'dist')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--draft', action='store_true', help='build a labeled candidate with publisher prerequisites still pending')
    mode.add_argument('--ready', action='store_true', help='require publisher prerequisites (the default)')
    parser.add_argument('--check-urls', action='store_true', help='check public metadata URLs over HTTPS')
    args = parser.parse_args()
    try:
        archive, audit = build(out=args.out, draft=args.draft, check_urls=args.check_urls)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.exit(2, f'release preflight failed: {exc}\n')
    print(json.dumps({'archive':str(archive), 'sha256':audit['sha256'], 'files':len(audit['files']),
                      'publication_pending':audit['publication_pending']}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
