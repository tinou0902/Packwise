/** Known vulnerability of a package version. Shared by the dotnet CLI model, the feed client and the webview. */
export interface Advisory {
  severity: string;
  advisoryUrl: string;
}

/** NuGet severities, from the least to the most severe (the index is the value used by the registration API). */
export const SEVERITIES = ['Low', 'Moderate', 'High', 'Critical'] as const;

/** Severity name from a registration value (index or name). */
export function severityName(s: string | number | undefined): string {
  if (s === undefined || s === '') return 'Unknown';
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isInteger(n) ? (SEVERITIES[n] ?? 'Unknown') : String(s);
}

/** The most severe of the advisories' severities (undefined when there is none). */
export function worstSeverity(advisories: readonly Advisory[]): string | undefined {
  const rank = (s: string) => (SEVERITIES as readonly string[]).indexOf(s);
  return advisories.map(a => a.severity).sort((a, b) => rank(b) - rank(a))[0];
}
