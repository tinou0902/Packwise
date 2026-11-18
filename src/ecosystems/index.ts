import type { Ecosystem } from '../ecosystem.ts';
import { npm } from './npm/index.ts';
import { nuget } from './nuget/index.ts';
import { pypi } from './pypi/index.ts';

/** Every supported ecosystem. The only module allowed to import a provider. */
export const ECOSYSTEMS: readonly Ecosystem[] = [nuget, npm, pypi];

export { npm, nuget, pypi };
