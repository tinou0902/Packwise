# NuKeeper for VS Code

Manage the NuGet packages of the .NET projects in your workspace, from the Explorer: declared and resolved versions,
latest stable version, direct and transitive packages, vulnerabilities, update and removal.

VS Code counterpart of the [NuKeeper TUI](https://gitlab.hexxusdata.com/perso/nukeeper/tui), with the same data sources:

- resolution, outdated and vulnerable packages through the `dotnet list package` CLI (honours your `NuGet.Config`);
- version history, metadata and per-version advisories through the nuget.org v3 API.

## Requirements

- The .NET SDK (`dotnet` on `PATH`).
- Network access for latest versions, vulnerabilities and details. Offline, the package list is still shown with a warning.

## Usage

The **NuGet Packages** view appears in the Explorer when the workspace contains a `.csproj`
(`bin`, `obj`, `node_modules` and `packages` folders are ignored). Expand a project to load its packages;
a project that was never restored is restored automatically.

| Where | Action |
|---|---|
| View title | **Filter** (all / outdated / vulnerable), **Refresh** (rescan the workspace) |
| Project | Refresh this project, open the project file |
| Package (inline or context menu) | **Update to latest stable**, **Choose version…** (vulnerable versions are flagged), **Remove** (direct packages only, with confirmation), **Open on nuget.org** |
| Package tooltip | Requested/resolved/latest versions, advisories, description, authors, downloads, dependencies |

Icons: shield = vulnerable, arrow = outdated, dimmed package = transitive. Type in the view to search packages.

The view refreshes when a `.csproj` changes, so edits made outside the extension show up too.

## Limitations

- Setting the version of a transitive package adds a direct reference to the project file (you are asked first).
- Only nuget.org is queried for details and version history.
- Only `.csproj` projects are scanned.

## Development

```sh
npm ci
npm test          # unit tests (node:test, native TypeScript)
npm run typecheck
npm run build     # bundle to dist/extension.cjs (F5 in VS Code to debug)
npm run package   # produce nukeeper-<version>.vsix
```

Install a build with `code --install-extension nukeeper-<version>.vsix`. The CI publishes the `.vsix` as a job artifact.
