import * as path from 'node:path';
import type { Ecosystem, PackageFeed, Source } from '../../ecosystem.ts';
import { addPackage, listSources, loadLatestPrerelease, loadProject, removePackage } from './cli.ts';
import { workspaceMembers } from '../../members.ts';
import { filterRoots } from './discovery.ts';
import { readManifest, workspacePatterns } from './manifest.ts';
import { NPMJS, RegistryClient } from './registry.ts';
import { npmRules } from './rules.ts';

/** Registry clients by URL, shared by every panel (their packument cache too). */
const clients = new Map<string, RegistryClient>();

const folderName = (file: string) => path.basename(path.dirname(file));

/**
 * npm: a root is a `package.json` with workspaces (its projects: itself and its members) or a standalone one.
 * Projects locked by pnpm or Yarn are shown read-only.
 */
export const npm: Ecosystem = {
  ...npmRules,
  id: 'npm',
  label: 'npm',
  rootGlob: '**/package.json',
  excludeGlob: '**/{node_modules,bower_components}/**',
  projectGlob: '**/package.json',
  defaultSources: [NPMJS],
  hasDevDependencies: true,

  filterRoots,
  rootName: folderName,
  projectName: folderName,

  async projectsOf(rootFile) {
    const patterns = workspacePatterns(await readManifest(rootFile));
    if (patterns.length === 0) return [rootFile];
    const members = await workspaceMembers(path.dirname(rootFile), patterns, 'package.json');
    return [rootFile, ...members.map(dir => path.join(dir, 'package.json'))];
  },

  load: loadProject,
  loadLatestPrerelease,
  add: addPackage,
  remove: removePackage,

  sources: rootFile => listSources(path.dirname(rootFile)),

  feed(source: Source): PackageFeed {
    let c = clients.get(source.url);
    if (!c) clients.set(source.url, (c = new RegistryClient(source)));
    return c;
  },

  resetFeeds: () => clients.clear(),
};
