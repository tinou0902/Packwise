import * as path from 'node:path';
import type { Ecosystem } from '../../ecosystem.ts';
import { workspaceMembers } from '../../members.ts';
import { addPackage, loadLatestPrerelease, loadProject, pypiClient, removePackage } from './cli.ts';
import { filterRoots } from './discovery.ts';
import { resetAudit } from './osv.ts';
import { hasDependencies, readPyProject, workspacePatterns } from './pyproject.ts';
import { PYPI } from './registry.ts';
import { pypiRules } from './rules.ts';

const folderName = (file: string) => path.basename(path.dirname(file));

/**
 * PyPI: a root is a `pyproject.toml` managed by uv, a uv workspace (its projects: itself when it has dependencies,
 * then its members) or a standalone project. Poetry, PDM and Pipenv projects are shown read-only. Only pypi.org is
 * browsed.
 */
export const pypi: Ecosystem = {
  ...pypiRules,
  id: 'pypi',
  label: 'PyPI',
  rootGlob: '**/pyproject.toml',
  excludeGlob: '**/{.venv,venv,node_modules,site-packages,__pycache__,.tox,.nox,build,dist}/**',
  projectGlob: '**/pyproject.toml',
  defaultSources: [PYPI],
  hasDevDependencies: true,

  filterRoots,
  rootName: folderName,
  projectName: folderName,

  async projectsOf(rootFile) {
    const pyproject = await readPyProject(rootFile);
    const patterns = workspacePatterns(pyproject);
    if (patterns.length === 0) return [rootFile];
    const members = await workspaceMembers(path.dirname(rootFile), patterns, 'pyproject.toml');
    return [...(hasDependencies(pyproject) ? [rootFile] : []), ...members.map(dir => path.join(dir, 'pyproject.toml'))];
  },

  load: loadProject,
  loadLatestPrerelease,
  add: addPackage,
  remove: removePackage,

  sources: async () => [PYPI],
  feed: () => pypiClient,
  resetFeeds: resetAudit,
};
