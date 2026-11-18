import * as path from 'node:path';

/** Project types the package manager handles. */
const PROJECT_FILE = /\.csproj$/i;

/**
 * Project files referenced by a solution, as absolute paths in solution order (duplicates removed).
 * `.sln`: `Project("{type}") = "Name", "rel\path.csproj", "{guid}"` lines; `.slnx`: `<Project Path="rel/path.csproj" />`.
 */
export function parseSolution(text: string, solutionFile: string): string[] {
  const relative = /\.slnx$/i.test(solutionFile)
    ? [...text.matchAll(/<Project\b[^>]*?\bPath\s*=\s*(["'])(.*?)\1/g)].map(m => decodeXml(m[2]))
    : [...text.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/gm)].map(m => m[1]);
  const dir = path.dirname(solutionFile);
  const files = relative
    .filter(p => PROJECT_FILE.test(p))
    // Solutions written on Windows use backslashes.
    .map(p => path.resolve(dir, p.replace(/\\/g, '/')));
  return [...new Set(files)];
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
