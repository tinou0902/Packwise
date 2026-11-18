import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { detectPackageManager, filterRoots, findWorkspaceRoot } from '../src/ecosystems/npm/discovery.ts';
import {
  declaredDependencies,
  isPackageName,
  isRegistryRange,
  isVersion,
  savePrefix,
  workspacePatterns,
} from '../src/ecosystems/npm/manifest.ts';
import { applyAudit, applyOutdated, highestTag, parseTree } from '../src/ecosystems/npm/model.ts';
import { encodeName, packumentVersions, parseConfig, parseSearch, RegistryClient, registryFor } from '../src/ecosystems/npm/registry.ts';
import { globToRegExp } from '../src/glob.ts';
import { workspaceMatcher, workspaceMembers } from '../src/members.ts';

test('glob patterns', () => {
  assert.ok(globToRegExp('**/package.json').test('package.json'));
  assert.ok(globToRegExp('**/package.json').test('a/b/package.json'));
  assert.ok(!globToRegExp('**/*.csproj').test('a/b.csproj.user'));
  assert.ok(globToRegExp('packages/*').test('packages/core'));
  assert.ok(!globToRegExp('packages/*').test('packages/core/sub'));
});

test('workspace patterns and matcher', () => {
  assert.deepEqual(workspacePatterns({ workspaces: ['packages/*'] }), ['packages/*']);
  assert.deepEqual(workspacePatterns({ workspaces: { packages: ['apps/*'] } }), ['apps/*']);
  assert.deepEqual(workspacePatterns({}), []);
  const isMember = workspaceMatcher(['./packages/*', 'tools/**', '!packages/legacy']);
  assert.ok(isMember('packages/core'));
  assert.ok(isMember('tools/a/b'));
  assert.ok(!isMember('packages/legacy'));
  assert.ok(!isMember(''));
  assert.ok(!isMember('apps/web'));
});

test('declared dependencies keep registry ranges only', () => {
  const deps = declaredDependencies({
    dependencies: { a: '^1.0.0', local: 'file:../local', ws: 'workspace:*', gh: 'user/repo', alias: 'npm:b@1' },
    devDependencies: { a: '^1.0.0', b: '~2.0.0' },
    peerDependencies: { c: '>=3' },
  });
  assert.deepEqual([...deps.entries()], [
    ['a', { range: '^1.0.0', field: 'dependencies' }],
    ['b', { range: '~2.0.0', field: 'devDependencies' }],
    ['c', { range: '>=3', field: 'peerDependencies' }],
  ]);
  assert.ok(isRegistryRange('*'));
  assert.ok(!isRegistryRange('git+https://x/y.git'));
});

test('range prefix is kept on update', () => {
  assert.equal(savePrefix('^1.2.3'), '^');
  assert.equal(savePrefix('~1.2.3'), '~');
  assert.equal(savePrefix('1.2.3'), '');
  assert.equal(savePrefix('>=1 <2'), '^');
  assert.equal(savePrefix(undefined), '^');
});

test('names and specs are validated', () => {
  assert.ok(isPackageName('@scope/pkg.name'));
  assert.ok(isPackageName('lodash'));
  assert.ok(!isPackageName('a & calc'));
  assert.ok(!isPackageName('../x'));
  assert.ok(isVersion('1.2.3-rc.1'));
  assert.ok(!isVersion('^1.2.3'));
  assert.ok(!isVersion('1.2.3 || rm'));
});

const LS = JSON.stringify({
  name: 'root',
  dependencies: {
    app: {
      version: '1.0.0',
      resolved: 'file:../apps/app',
      dependencies: {
        react: { version: '18.3.1', resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz', dependencies: { 'loose-envify': { version: '1.4.0' } } },
        missing: { missing: true },
      },
    },
    typescript: { version: '5.6.3', dependencies: { 'loose-envify': { version: '1.3.0' } } },
  },
});

test('npm ls tree: direct, transitive, workspace subtree', () => {
  const manifest = { dependencies: { react: '^18.0.0', missing: '^1.0.0' }, devDependencies: { vitest: '^2.0.0' } };
  const data = parseTree(LS, manifest, 'app');
  const react = data.packages.get('react')!;
  assert.equal(react.isDirect, true);
  assert.equal(react.requested, '^18.0.0');
  assert.equal(react.resolved, '18.3.1');
  assert.equal(data.packages.get('missing')!.resolved, '');
  assert.equal(data.packages.get('vitest')!.kind, 'dev');
  assert.equal(data.packages.get('loose-envify')!.isDirect, false);
  assert.ok(!data.packages.has('typescript'));

  const root = parseTree(LS, { devDependencies: { typescript: '~5.6.0' } });
  assert.equal(root.packages.get('typescript')!.resolved, '5.6.3');
  assert.ok(!root.packages.has('app'), 'local workspace packages are skipped');
  assert.equal(root.packages.get('loose-envify')!.resolved, '1.3.0', 'workspace subtrees belong to their member');
  assert.throws(() => parseTree(LS, {}, 'nope'));
});

test('npm outdated and audit', () => {
  const data = parseTree(LS, { dependencies: { react: '^18.0.0' } }, 'app');
  applyOutdated(data, JSON.stringify({
    react: [{ latest: '19.0.0', dependent: 'other' }, { latest: '19.1.0', dependent: 'app' }],
    'loose-envify': { latest: '9.9.9' },
  }), 'app');
  assert.equal(data.packages.get('react')!.latest, '19.1.0');
  assert.equal(data.packages.get('loose-envify')!.latest, '', 'transitive packages have no latest');
  applyOutdated(data, '', 'app');

  applyAudit(data, JSON.stringify({
    vulnerabilities: {
      react: { via: ['loose-envify'] },
      'loose-envify': { via: [{ url: 'https://github.com/advisories/GHSA-1', severity: 'high' }, { url: 'https://github.com/advisories/GHSA-1', severity: 'high' }] },
    },
  }));
  assert.deepEqual(data.packages.get('react')!.vulnerabilities, []);
  assert.deepEqual(data.packages.get('loose-envify')!.vulnerabilities, [{ severity: 'High', advisoryUrl: 'https://github.com/advisories/GHSA-1' }]);
  assert.throws(() => applyAudit(data, JSON.stringify({ error: { code: 'ENOLOCK' } })));
});

test('dist-tags', () => {
  assert.equal(highestTag({ latest: '1.2.0', next: '2.0.0-rc.1', legacy: '0.9.0' }), '2.0.0-rc.1');
  assert.equal(highestTag({}), undefined);
});

test('registries from npm config', () => {
  const sources = parseConfig(JSON.stringify({ registry: 'https://registry.npmjs.org/', '@acme:registry': 'https://npm.acme.dev/repo', 'cache': '/x' }));
  assert.deepEqual(sources, [
    { name: 'npmjs.com', url: 'https://registry.npmjs.org/' },
    { name: '@acme (npm.acme.dev)', url: 'https://npm.acme.dev/repo/' },
  ]);
  assert.equal(registryFor('@acme/ui', sources), 'https://npm.acme.dev/repo/');
  assert.equal(registryFor('@other/ui', sources), 'https://registry.npmjs.org/');
  assert.equal(registryFor('lodash', []), 'https://registry.npmjs.org/');
  assert.equal(encodeName('@acme/ui'), '@acme%2Fui');
});

test('packument and search', () => {
  const versions = packumentVersions({
    name: 'pkg',
    'dist-tags': { latest: '1.10.0' },
    time: { '1.10.0': '2026-01-01T00:00:00.000Z' },
    versions: {
      '1.10.0': { version: '1.10.0', license: 'MIT', repository: { url: 'git+https://github.com/o/pkg.git' }, peerDependencies: { react: '>=18' } },
      '1.9.0': { version: '1.9.0', deprecated: 'Use 1.10', author: 'Jane <j@x.dev>' },
    },
  }, true);
  assert.deepEqual(versions.map(v => v.version), ['1.9.0', '1.10.0']);
  const [old, latest] = versions;
  assert.equal(old.deprecation?.message, 'Use 1.10');
  assert.equal(old.authors, 'Jane');
  assert.equal(latest.projectUrl, 'https://github.com/o/pkg');
  assert.equal(latest.licenseExpression, 'MIT');
  assert.equal(latest.published, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(latest.dependencies, [{ group: 'peerDependencies', packages: [{ id: 'react', range: '>=18' }] }]);
  assert.equal(latest.galleryUrl, 'https://www.npmjs.com/package/pkg/v/1.10.0');

  const { hits, total } = parseSearch({ total: 42, objects: [{ package: { name: 'a', version: '1.0.0', publisher: { username: 'bob' } } }] }, 'npmjs.com');
  assert.equal(total, 42);
  assert.equal(hits[0].authors, 'bob');
  assert.equal(hits[0].source, 'npmjs.com');
});

test('workspace discovery on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packwise-npm-'));
  try {
    const write = async (rel: string, content: object | string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
    };
    await write('package.json', { name: 'root', workspaces: ['packages/*'] });
    await write('packages/a/package.json', { name: 'a' });
    await write('packages/b/package.json', { name: 'b' });
    await write('packages/a/node_modules/x/package.json', { name: 'x' });
    await write('tools/package.json', { name: 'tools' });
    await write('pnpm-lock.yaml', '');

    const file = (rel: string) => path.join(dir, rel);
    const roots = await filterRoots([file('package.json'), file('packages/a/package.json'), file('tools/package.json')]);
    assert.deepEqual(roots, [file('package.json'), file('tools/package.json')]);
    assert.deepEqual(await workspaceMembers(dir, ['packages/*'], 'package.json'), [file('packages/a'), file('packages/b')]);
    assert.equal((await findWorkspaceRoot(file('packages/a')))?.dir, dir);
    assert.equal(await findWorkspaceRoot(file('tools')), undefined);
    assert.equal(await detectPackageManager(dir, {}), 'pnpm');
    assert.equal(await detectPackageManager(dir, { packageManager: 'yarn@4.0.0' }), 'yarn');
    assert.equal(await detectPackageManager(file('tools'), {}), 'npm');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an empty npm search returns nothing without querying the registry', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('no request expected')));
  const client = new RegistryClient({ name: 'npmjs.com', url: 'https://registry.npmjs.org/' });
  assert.deepEqual(await client.search('', 0, 25), { hits: [], total: 0 });
  assert.deepEqual(await client.search('   ', 0, 25), { hits: [], total: 0 });
  assert.equal(fetch.mock.callCount(), 0);
});
