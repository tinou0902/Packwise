# Changelog

## Unreleased

- Files ignored by git are no longer listed as roots: build outputs such as `.next/` no longer add copies of
  `package.json`.

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
