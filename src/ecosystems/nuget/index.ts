import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Ecosystem, PackageFeed, Source } from '../../ecosystem.ts';
import { addPackage, listSources, loadLatestPrerelease, loadProject, removePackage } from './dotnet.ts';
import { FeedClient, NUGET_ORG } from './feed.ts';
import { nugetRules } from './rules.ts';
import { parseSolution } from './solution.ts';

/** Feed clients by service index URL, shared by every panel (their registration cache too). */
const clients = new Map<string, FeedClient>();

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** NuGet: solutions (`.sln`/`.slnx`) of `.csproj` projects, managed with the dotnet CLI and NuGet v3 feeds. */
export const nuget: Ecosystem = {
  ...nugetRules,
  id: 'nuget',
  label: 'NuGet',
  rootGlob: '**/*.{sln,slnx}',
  excludeGlob: '**/{bin,obj,node_modules,packages}/**',
  rootLabel: "Solution '{0}'",
  projectGlob: '**/*.csproj',
  defaultSources: [NUGET_ORG],
  hasDevDependencies: false,

  filterRoots: async files => files,

  rootName: file => path.basename(file).replace(/\.slnx?$/i, ''),
  projectName: file => path.basename(file, '.csproj'),

  async projectsOf(solutionFile) {
    const files = parseSolution(await fs.readFile(solutionFile, 'utf8'), solutionFile);
    const found = await Promise.all(files.map(exists));
    return files.filter((_, i) => found[i]);
  },

  load: loadProject,
  loadLatestPrerelease,
  add: (file, id, version) => addPackage(file, id, version),
  remove: removePackage,

  // NuGet.Config files apply to the solution folder and its parents.
  sources: solutionFile => listSources(path.dirname(solutionFile)),

  feed(source: Source): PackageFeed {
    let c = clients.get(source.url);
    if (!c) clients.set(source.url, (c = new FeedClient(source)));
    return c;
  },

  resetFeeds: () => clients.clear(),
};
