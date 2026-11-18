# Packwise

Manage the NuGet packages of your .NET solutions and the npm packages of your JavaScript projects in a package manager
modelled on Visual Studio's **Manage NuGet Packages for Solution** window: browse, install, update, uninstall and
consolidate packages, with vulnerable and deprecated versions flagged.

![Browse tab: search results and package details](images/browse.png)

## Features

- **NuGet** (.NET solutions) and **npm** (`package.json`, workspaces included) in the same panel.
- Search the package sources of your `NuGet.Config` or the registries of your `.npmrc` and see, on each result, which
  version your projects use.
- Install, update and uninstall packages in one or several projects of a solution or an npm workspace at once.
- Update every outdated package in one go from the **Updates** tab.
- Spot vulnerable, deprecated and unlisted versions before picking one.
- Align packages installed with different versions across projects (**Consolidate**).
- English and French user interface.

![Updates tab: outdated packages selected for a bulk update](images/updates.png)

## Requirements

- NuGet: the .NET SDK (`dotnet` on `PATH`) and a `.sln` or `.slnx` file referencing the `.csproj` projects.
- npm: Node.js and npm (`npm` on `PATH`), and a `package.json`. Run `npm install` first so that installed versions,
  transitive packages and vulnerabilities (which need `package-lock.json`) are available.
- Network access for latest versions, vulnerabilities and details. Offline, installed packages are still shown with a warning.

## Usage

The **Packwise** icon appears in the activity bar when the workspace contains a solution or a `package.json`
(`node_modules` folders are ignored, and `bin`, `obj` and `packages` for solutions). Each solution, npm workspace root
or standalone `package.json` is a root; the members of an npm workspace are the projects of its root. Clicking the icon
opens the package manager of the root in an editor tab. With several roots, the sidebar lists them (grouped by
ecosystem when there are several): pick one, and the icon then reopens the last one used.
**Manage Packages…** is also in the context menu of a `.sln`/`.slnx` or `package.json` file in the Explorer, in the
editor title of an open one, and in the command palette. The `packwise.ecosystems` setting turns an ecosystem off
(for example `"packwise.ecosystems": { "npm": false }`).

| Tab | Content |
|---|---|
| **Browse** | Search the package sources (infinite scroll); installed versions and updates are shown on each row |
| **Installed** | Top-level packages, then transitive ones (collapsed) |
| **Updates** | Outdated top-level packages, with check boxes and **Update** for several packages at once |
| **Consolidate** | Packages installed with different versions across the projects |

The toolbar has the search box (`Ctrl+L`), **Refresh**, **Include prerelease** and the **Package source** picker
(enabled HTTP(S) sources of `dotnet nuget list source`, or all of them). Selecting a package shows its details: the
projects of the solution and their version, the version picker (latest stable/prerelease, vulnerable, deprecated and
unlisted versions flagged), **Install**/**Uninstall** for the checked projects, vulnerability and deprecation notices,
metadata (owners, authors, license, downloads, publication date, URLs, tags) and dependencies per target framework
(per dependency type for npm). Changes run through `dotnet add/remove package` or `npm install/uninstall` with a
cancellable progress notification; the commands and their output are written to the **Packwise** output channel.

For npm, dependency types are shown as badges (`dev`, `peer`, `optional`) and kept on update, as is the range prefix
(`^`, `~` or an exact version). A new reference goes to `dependencies`, or to `devDependencies` with the
**Development dependency** option.

The panel reloads when a project file or the solution changes, so edits made outside the extension show up too.
A project that was never restored is restored automatically.

## Limitations

- NuGet: only `.csproj` projects of the solution are handled. Sources needing credentials and local folder or NuGet v2
  sources are not browsed (they are still used by `dotnet` when installing).
- npm: projects managed by pnpm or Yarn (`packageManager` field or lockfile) are read-only: their packages, installed
  and latest versions are shown, changes are left to their own CLI. Registries needing credentials are not browsed
  (they are still used by `npm` when installing). Local, Git and `workspace:` dependencies are not listed.
- Installing a transitive package adds a top-level reference to the project file.

## Development

Each ecosystem implements the `Ecosystem` interface (`src/ecosystem.ts`) in `src/ecosystems/<id>/`. NuGet: installed
and outdated packages come from the `dotnet list package` CLI; search, version history and metadata from the NuGet v3
API of the configured package sources. npm: installed, outdated and vulnerable packages come from `npm ls`,
`npm outdated` and `npm audit`; search, version history and metadata from the registry API.

```sh
npm ci
npm test          # unit tests (node:test, native TypeScript)
npm run typecheck
npm run build     # bundle to dist/extension.cjs and dist/webview.js (F5 in VS Code to debug)
npm run package   # produce packwise-<version>.vsix
```

Install a build with `code --install-extension packwise-<version>.vsix`. The CI keeps the `.vsix` of every pipeline as a job artifact (90 days). Pushing a `vX.Y.Z` tag matching the `package.json` version also stores it in the package registry and creates a GitLab release linking to it.

## License

[MIT](LICENSE)

Packwise is an independent project, not affiliated with or endorsed by Microsoft, the .NET Foundation, GitHub or npm, Inc.
