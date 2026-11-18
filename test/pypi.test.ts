import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { detectPackageManager, filterRoots, findWorkspaceRoot } from '../src/ecosystems/pypi/discovery.ts';
import { parseLock, projectData } from '../src/ecosystems/pypi/lock.ts';
import { toAdvisories } from '../src/ecosystems/pypi/osv.ts';
import { comparePep440, isPep440Prerelease, normalizeName, parsePep440 } from '../src/ecosystems/pypi/pep440.ts';
import {
  declaredDependencies,
  isPackageName,
  isVersion,
  kindOf,
  locationArgs,
  parsePyProject,
  parseRequirement,
  requirementFor,
  workspacePatterns,
} from '../src/ecosystems/pypi/pyproject.ts';
import { fileVersion, latestRelease, parseReleases, requiresDist, toVersionDetails } from '../src/ecosystems/pypi/registry.ts';
import { workspaceMembers } from '../src/members.ts';

test('PEP 440 ordering', () => {
  const ordered = ['1.0.dev0', '1.0a1', '1.0a2.dev1', '1.0a2', '1.0b1', '1.0rc1', '1.0', '1.0+local', '1.0.post1.dev0', '1.0.post1', '1.0-2', '1.1', '1!0.1'];
  assert.deepEqual([...ordered].reverse().sort(comparePep440), ordered);
  assert.equal(comparePep440('1.0', '1.0.0'), 0);
  assert.equal(comparePep440('2.0.0RC1', '2.0.0rc1'), 0);
  assert.ok(comparePep440('1.10', '1.9') > 0);
});

test('PEP 440 parsing and prereleases', () => {
  assert.deepEqual(parsePep440('v1.2-alpha.3'), { epoch: 0, release: [1, 2], pre: { phase: 'a', n: 3 }, post: undefined, dev: undefined, local: '' });
  assert.equal(parsePep440('1.0-2')?.post, 2);
  assert.equal(parsePep440('1.0.post')?.post, 0);
  assert.equal(parsePep440('1.0+Ubuntu-1')?.local, 'ubuntu.1');
  assert.equal(parsePep440('latest'), undefined);
  assert.ok(isPep440Prerelease('2.0rc1'));
  assert.ok(isPep440Prerelease('2.0.dev3'));
  assert.ok(!isPep440Prerelease('2.0.post1'));
  assert.ok(isVersion('2024.1'));
  assert.ok(!isVersion('1.0; rm -rf'));
});

test('PEP 503 names', () => {
  assert.equal(normalizeName('Friendly-Bard'), 'friendly-bard');
  assert.equal(normalizeName('FRIENDLY._-bard'), 'friendly-bard');
  assert.ok(isPackageName('zope.interface'));
  assert.ok(!isPackageName('-dash'));
  assert.ok(!isPackageName('a b'));
});

test('PEP 508 requirements', () => {
  assert.deepEqual(parseRequirement('requests[security, socks] >=2.8.1, ==2.8.*; python_version < "2.7"'), {
    name: 'requests',
    extras: ['security', 'socks'],
    specifier: '>=2.8.1,==2.8.*',
    marker: 'python_version < "2.7"',
  });
  assert.deepEqual(parseRequirement('Django'), { name: 'Django', extras: [], specifier: '', marker: '' });
  assert.equal(parseRequirement('name (>=1.0)')?.specifier, '>=1.0');
  assert.equal(parseRequirement('pip @ https://github.com/pypa/pip/archive/1.3.1.zip'), undefined);
});

test('requirement for a new version keeps extras, marker and a single operator', () => {
  const current = parseRequirement('httpx[http2]==0.27.0; python_version >= "3.9"');
  assert.equal(requirementFor('httpx', '0.28.1', current), 'httpx[http2]==0.28.1; python_version >= "3.9"');
  assert.equal(requirementFor('rich', '13.9.0', parseRequirement('rich~=13.0')), 'rich~=13.9.0');
  assert.equal(requirementFor('rich', '13.9.0', parseRequirement('rich>=12,<14')), 'rich>=13.9.0');
  assert.equal(requirementFor('rich', '13.9.0'), 'rich>=13.9.0');
});

const PYPROJECT = `
[project]
name = "app"
dependencies = ["httpx[http2]>=0.27", "Rich~=13.0", "local @ file:///tmp/local"]

[project.optional-dependencies]
cli = ["typer>=0.12", "rich"]

[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]
lint = ["ruff"]

[tool.uv]
dev-dependencies = ["mypy"]

[tool.uv.workspace]
members = ["packages/*"]
exclude = ["packages/legacy"]
`;

test('declared dependencies and locations', () => {
  const p = parsePyProject(PYPROJECT);
  const declared = declaredDependencies(p);
  assert.deepEqual([...declared.keys()], ['httpx', 'rich', 'typer', 'pytest', 'ruff', 'mypy']);
  assert.equal(kindOf(declared.get('rich')!.location), undefined);
  assert.equal(kindOf(declared.get('typer')!.location), '[cli]');
  assert.equal(kindOf(declared.get('pytest')!.location), 'dev');
  assert.deepEqual(locationArgs(declared.get('typer')!.location), ['--optional', 'cli']);
  assert.deepEqual(locationArgs(declared.get('pytest')!.location), ['--dev']);
  assert.deepEqual(locationArgs(declared.get('ruff')!.location), ['--group', 'lint']);
  assert.deepEqual(locationArgs(declared.get('mypy')!.location), ['--dev']);
  assert.deepEqual(workspacePatterns(p), ['packages/*', '!packages/legacy']);
  assert.deepEqual(workspacePatterns(parsePyProject('[project]\nname = "x"')), []);
});

const LOCK = `
version = 1
requires-python = ">=3.12"

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "httpx", extra = ["http2"] }, { name = "rich" }]

[[package]]
name = "httpx"
version = "0.27.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "anyio" }, { name = "certifi" }]

[package.optional-dependencies]
http2 = [{ name = "h2" }]

[[package]]
name = "anyio"
version = "4.6.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "certifi"
version = "2024.8.30"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "h2"
version = "4.1.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "rich"
version = "13.8.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "numpy"
version = "1.26.4"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "numpy"
version = "2.1.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "8.3.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "numpy", version = "1.26.4" }]
`;

test('project data from uv.lock', () => {
  const data = projectData(parsePyProject(PYPROJECT), parseLock(LOCK));
  const resolved = Object.fromEntries([...data.packages].map(([k, p]) => [k, `${p.resolved}${p.isDirect ? '' : ' (transitive)'}`]));
  assert.deepEqual(resolved, {
    httpx: '0.27.2',
    rich: '13.8.1',
    typer: '',
    pytest: '8.3.3',
    ruff: '',
    mypy: '',
    anyio: '4.6.0 (transitive)',
    certifi: '2024.8.30 (transitive)',
    h2: '4.1.0 (transitive)',
    numpy: '1.26.4 (transitive)',
  });
  assert.equal(data.packages.get('rich')!.id, 'Rich');
  assert.equal(data.packages.get('rich')!.requested, '~=13.0');
});

test('declared packages only without a lock', () => {
  const data = projectData(parsePyProject(PYPROJECT));
  assert.equal(data.packages.size, 6);
  assert.ok([...data.packages.values()].every(p => p.isDirect && p.resolved === ''));
});

test('OSV advisories', () => {
  const advisories = toAdvisories([
    { id: 'GHSA-1', aliases: ['CVE-1', 'PYSEC-1'], database_specific: { severity: 'MODERATE' } },
    { id: 'PYSEC-1', aliases: ['CVE-1', 'GHSA-1'] },
    { id: 'PYSEC-2', aliases: ['CVE-2'] },
    { id: 'GHSA-3', withdrawn: '2024-01-01T00:00:00Z', database_specific: { severity: 'HIGH' } },
  ]);
  assert.deepEqual(advisories, [
    { severity: 'Moderate', advisoryUrl: 'https://osv.dev/vulnerability/GHSA-1' },
    { severity: 'Unknown', advisoryUrl: 'https://osv.dev/vulnerability/PYSEC-2' },
  ]);
});

test('PyPI releases from the simple API', () => {
  assert.equal(fileVersion('Django-5.1.1-py3-none-any.whl', 'django'), '5.1.1');
  assert.equal(fileVersion('zope.interface-7.0.3.tar.gz', 'zope-interface'), '7.0.3');
  assert.equal(fileVersion('my-pkg-1.0rc1.zip', 'my_pkg'), '1.0rc1');
  const releases = parseReleases({
    name: 'demo',
    versions: ['1.0', '1.1', '2.0b1'],
    files: [
      { filename: 'demo-1.0.tar.gz', 'upload-time': '2024-02-01T00:00:00Z' },
      { filename: 'demo-1.0-py3-none-any.whl', 'upload-time': '2024-01-01T00:00:00Z' },
      { filename: 'demo-1.1.tar.gz', 'upload-time': '2024-03-01T00:00:00Z', yanked: 'broken' },
      { filename: 'demo-2.0b1.tar.gz', 'upload-time': '2024-04-01T00:00:00Z' },
    ],
  });
  assert.deepEqual(releases, [
    { version: '1.0', published: '2024-01-01T00:00:00Z', listed: true },
    { version: '1.1', published: '2024-03-01T00:00:00Z', listed: false },
    { version: '2.0b1', published: '2024-04-01T00:00:00Z', listed: true },
  ]);
  assert.equal(latestRelease(releases, false)?.version, '1.0');
  assert.equal(latestRelease(releases, true)?.version, '2.0b1');

  const details = toVersionDetails(releases, {
    name: 'Demo',
    version: '2.0b1',
    summary: 'A demo',
    author_email: 'Ann <ann@example.com>, Bob <bob@example.com>',
    license_expression: 'MIT',
    project_urls: { Documentation: 'https://docs', Source: 'https://src' },
    requires_dist: ['idna>=2.5', 'h2<5,>=3; extra == "http2"'],
  }, 'demo');
  assert.equal(details[0].dependencies, undefined);
  assert.deepEqual(details[2].dependencies, [
    { group: '', packages: [{ id: 'idna', range: '>=2.5' }] },
    { group: '[http2]', packages: [{ id: 'h2', range: '<5,>=3' }] },
  ]);
  assert.equal(details[2].authors, 'Ann, Bob');
  assert.equal(details[2].projectUrl, 'https://src');
  assert.equal(details[2].galleryUrl, 'https://pypi.org/project/Demo/2.0b1/');
  assert.deepEqual(requiresDist([]), []);
});

test('uv workspace discovery on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packwise-pypi-'));
  try {
    const write = async (rel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    };
    await write('pyproject.toml', '[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/legacy"]\n');
    await write('packages/a/pyproject.toml', '[project]\nname = "a"\n');
    await write('packages/legacy/pyproject.toml', '[project]\nname = "legacy"\n');
    await write('packages/a/.venv/lib/pyproject.toml', '[project]\nname = "x"\n');
    await write('tools/pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    await write('poetry/pyproject.toml', '[project]\nname = "p"\n');
    await write('poetry/poetry.lock', '');
    await write('uv.lock', 'version = 1\n');

    const file = (rel: string) => path.join(dir, rel);
    const roots = await filterRoots([file('pyproject.toml'), file('packages/a/pyproject.toml'), file('packages/legacy/pyproject.toml'), file('tools/pyproject.toml'), file('poetry/pyproject.toml')]);
    assert.deepEqual(roots, [file('pyproject.toml'), file('packages/legacy/pyproject.toml'), file('poetry/pyproject.toml')]);
    assert.deepEqual(await workspaceMembers(dir, ['packages/*', '!packages/legacy'], 'pyproject.toml'), [file('packages/a')]);
    assert.equal((await findWorkspaceRoot(file('packages/a')))?.dir, dir);
    assert.equal((await findWorkspaceRoot(dir))?.dir, dir);
    assert.equal(await findWorkspaceRoot(file('packages/legacy')), undefined);
    assert.equal(await detectPackageManager(dir, {}), 'uv');
    assert.equal(await detectPackageManager(file('poetry'), {}), 'Poetry');
    assert.equal(await detectPackageManager(file('tools'), {}), 'uv');
    assert.equal(await detectPackageManager(file('tools'), { tool: { poetry: {} } }), 'Poetry');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
