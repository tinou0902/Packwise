import type { Ecosystem } from '../ecosystem.ts';
import { nuget } from './nuget/index.ts';

/** Every supported ecosystem. The only module allowed to import a provider. */
export const ECOSYSTEMS: readonly Ecosystem[] = [nuget];

export { nuget };
