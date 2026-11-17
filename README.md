# NuKeeper for VS Code

Manage the NuGet packages of your .NET solutions in a package manager modelled on Visual Studio's
**Manage NuGet Packages for Solution** window: browse, install, update, uninstall and consolidate packages, with
vulnerable and deprecated versions flagged.

VS Code counterpart of the [NuKeeper TUI](https://gitlab.hexxusdata.com/perso/nukeeper/tui):

- installed, outdated and vulnerable packages through the `dotnet list package` CLI (honours your `NuGet.Config`);
- search, version history and metadata through the NuGet v3 API of the configured package sources.

## Requirements

- The .NET SDK (`dotnet` on `PATH`).
- A `.sln` or `.slnx` file referencing the `.csproj` projects.
- Network access for latest versions, vulnerabilities and details. Offline, installed packages are still shown with a warning.

## Usage

The **NuGet** icon appears in the activity bar when the workspace contains a solution (`bin`, `obj`, `node_modules` and
`packages` folders are ignored). Clicking it opens the package manager of the solution in an editor tab. With several
solutions, the sidebar lists them: pick one, and the icon then reopens the last one used.
**Manage NuGet Packages for Solution…** is also in the context menu of a `.sln`/`.slnx` file in the Explorer, in the
editor title of an open solution file, and in the command palette.

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
metadata (owners, authors, license, downloads, publication date, URLs, tags) and dependencies per target framework.
Changes run through `dotnet add/remove package` with a cancellable progress notification; the commands and their
output are written to the **NuKeeper** output channel.

The panel reloads when a project file or the solution changes, so edits made outside the extension show up too.
A project that was never restored is restored automatically.

## Limitations

- Only `.csproj` projects of the solution are handled.
- Installing a transitive package adds a top-level reference to the project file.
- Sources needing credentials and local folder or NuGet v2 sources are not browsed (they are still used by `dotnet`
  when installing).

## Development

```sh
npm ci
npm test          # unit tests (node:test, native TypeScript)
npm run typecheck
npm run build     # bundle to dist/extension.cjs and dist/webview.js (F5 in VS Code to debug)
npm run package   # produce nukeeper-<version>.vsix
```

Install a build with `code --install-extension nukeeper-<version>.vsix`. The CI keeps the `.vsix` of every pipeline as a job artifact (90 days). Pushing a `vX.Y.Z` tag matching the `package.json` version also stores it in the package registry and creates a GitLab release linking to it.

## License

[MIT](LICENSE)
