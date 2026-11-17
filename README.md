# NuKeeper for VS Code

Manage the NuGet packages of the .NET projects in your workspace, from the Explorer: declared and resolved versions,
latest stable version, direct and transitive packages, vulnerabilities, update and removal.

VS Code counterpart of the [NuKeeper TUI](https://gitlab.hexxusdata.com/perso/nukeeper/tui), with the same data sources:

- resolution, outdated and vulnerable packages through the `dotnet list package` CLI (honours your `NuGet.Config`);
- version history, metadata and per-version advisories through the NuGet v3 API.

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

### Package manager

**Manage NuGet Packages** opens a panel modelled on Visual Studio's NuGet Package Manager:

- **Manage NuGet Packages for Solution** (button in the view title): every project of the workspace;
- **Manage NuGet Packages** (context menu of a project in the view or of a `.csproj` in the Explorer, editor title of a
  `.csproj`): a single project. **Manage in Package Manager** on a package opens it there, selected.

| Tab | Content |
|---|---|
| **Browse** | Search the package sources (infinite scroll); installed versions and updates are shown on each row |
| **Installed** | Top-level packages, then transitive ones (collapsed) |
| **Updates** | Outdated top-level packages, with check boxes and **Update** for several packages at once |
| **Consolidate** | Solution only: packages installed with different versions across projects |

The toolbar has the search box (`Ctrl+L`), **Refresh**, **Include prerelease** and the **Package source** picker
(enabled HTTP(S) sources of `dotnet nuget list source`, or all of them). Selecting a package shows its details: the
projects that reference it and their version (solution), the version picker (latest stable/prerelease, vulnerable,
deprecated and unlisted versions flagged), **Install**/**Update**/**Uninstall**, vulnerability and deprecation notices,
metadata (owners, authors, license, downloads, publication date, URLs, tags) and dependencies per target framework.
Changes run through `dotnet add/remove package` with a cancellable progress notification; the commands and their
output are written to the **NuKeeper** output channel.

Icons: shield = vulnerable, arrow = outdated, dimmed package = transitive. Type in the view to search packages.

The view refreshes when a `.csproj` changes, so edits made outside the extension show up too.

## Limitations

- Setting the version of a transitive package adds a direct reference to the project file (you are asked first).
- The tree view tooltips query nuget.org only; the package manager queries the configured sources.
- Sources needing credentials and local folder or NuGet v2 sources are not browsed (they are still used by `dotnet`
  when installing).
- Only `.csproj` projects are scanned.

## Development

```sh
npm ci
npm test          # unit tests (node:test, native TypeScript)
npm run typecheck
npm run build     # bundle to dist/extension.cjs and dist/webview.js (F5 in VS Code to debug)
npm run package   # produce nukeeper-<version>.vsix
```

Install a build with `code --install-extension nukeeper-<version>.vsix`. The CI keeps the `.vsix` of every pipeline as a job artifact (90 days). Pushing a `vX.Y.Z` tag matching the `package.json` version also stores it in the package registry and creates a GitLab release linking to it.
