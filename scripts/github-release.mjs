// Creates the GitHub release of a tag on the public mirror (the GitLab push mirror copies tags, not releases),
// with the CHANGELOG section of the version as notes and the .vsix as asset. Idempotent: an existing release is
// kept and only a missing asset is uploaded.
// Usage: GITHUB_TOKEN=… node scripts/github-release.mjs <tag> <vsix file>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const REPO = 'tinou0902/packwise';
const [tag, vsix] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!tag || !vsix || !token) {
  console.error('Usage: GITHUB_TOKEN=… node scripts/github-release.mjs <tag> <vsix file>');
  process.exit(2);
}

const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok && res.status !== 404) throw new Error(`${init.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 404 ? undefined : res.json();
}

/** Section "## <version>" of the CHANGELOG, up to the next version. */
function notes(version) {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const start = lines.findIndex(l => l.trim() === `## ${version}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

let release = await api(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
if (release) console.log(`Release ${tag} already exists`);
else {
  release = await api(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: `Packwise ${tag}`, body: notes(tag.replace(/^v/, '')), make_latest: 'legacy' }),
  });
  console.log(`Created release ${tag}`);
}

const name = basename(vsix);
if (release.assets.some(a => a.name === name)) console.log(`Asset ${name} already uploaded`);
else {
  await api(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(vsix),
  });
  console.log(`Uploaded ${name}`);
}
console.log(release.html_url);
