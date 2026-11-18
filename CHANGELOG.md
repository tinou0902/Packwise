# Changelog

## Unreleased

- Faster panel on large projects: rows look their package up in an index instead of scanning every package, and
  bursts of messages (one package summary per visible row) are rendered once per frame. Spinners no longer restart
  (and stutter) on every render.
- NuGet: about 3× faster loading on solutions with many projects. The solution is restored once, then each project
  is listed without its own implicit restore, and its three `dotnet list package` calls (installed, outdated,
  vulnerable) run at once; the prerelease lookup runs alongside them too.
- npm: `npm ls` now runs alongside `npm outdated` and `npm audit` instead of before them.
- Files ignored by git are no longer listed as roots: build outputs such as `.next/` no longer add copies of
  `package.json`.
- npm: the Browse tab no longer fails with "400 Bad Request" when the search is empty; it asks for a package name
  instead, as the npm registry has no listing of popular packages.
- **Vulnerable only** filter: every tab lists only the packages with a known vulnerability (an installed version,
  direct or transitive, or the search result). Transitive packages now show the vulnerability flag too.
- The panel looks more like VS Code itself:
  - Codicons instead of hand-drawn icons, and check boxes drawn with the theme's checkbox colours.
  - Tabs styled like the panel's (Problems, Output…), with counters: installed packages, and vulnerable ones in red.
  - **Include prerelease** and **Vulnerable only** are toggles inside the search box, like the find widget's options.
  - The "Package Manager" heading is gone (the editor tab already names the root), and so is the source picker when
    there is a single source.
  - npm and PyPI rows are compact, without the placeholder icon column (their registries have no package icons).
  - The vulnerability flag is coloured by the worst severity (critical, high, moderate, low), with the severities in
    its tooltip.

## 0.5.0

- **npm support**: `package.json` projects and npm workspaces get the same package manager as .NET solutions. Installed
  packages, updates and vulnerabilities come from the npm CLI, search and details from the registries of `.npmrc`
  (scoped ones included).
- npm dependency types shown as badges and kept on update, with the range prefix (`^`, `~`, exact); new references can
  be added as development dependencies.
- pnpm and Yarn projects are shown read-only.
- The sidebar lists the solutions and npm roots of the workspace, grouped by ecosystem; **Manage Packages…** replaces
  the NuGet-specific command.
- **Python support**: `pyproject.toml` projects and workspaces managed by uv. Installed and transitive packages come
  from `uv.lock`, latest versions and details from PyPI, vulnerabilities from OSV.dev; changes run through
  `uv add/remove`, keeping the extra or dependency group, extras, marker and operator of each requirement.
- Poetry, PDM and Pipenv projects are shown read-only.
- `packwise.ecosystems` setting to turn an ecosystem off.

## 0.4.0

First public release.

- Package manager modelled on Visual Studio's **Manage NuGet Packages for Solution** window, opened from the activity
  bar, the Explorer context menu of a `.sln`/`.slnx` file or the command palette.
- **Browse**, **Installed**, **Updates** and **Consolidate** tabs; install, update, uninstall and consolidate packages
  across the projects of a solution.
- Vulnerable, deprecated and unlisted versions flagged in the lists and the version picker.
- Search across the HTTP(S) package sources of `NuGet.Config`, one at a time or all of them.
- English and French user interface.
