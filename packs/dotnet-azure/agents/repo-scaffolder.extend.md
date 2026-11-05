# Scaffolding a .NET repo

From the `dotnet-azure` stack pack. When the new repo is a .NET project,
these are the conventions for the files `context.files_to_create` names:

- `<new_repo_id>.sln` — empty solution containing the new csproj.
- `*.csproj` — minimal compilable project, no implementation.
- `nuget_package_publish.ps1` — copy the convention from a sibling
  `*.csproj` directory in `context.repo_path` (auto-bumps patch,
  `dotnet pack`, pushes to the configured feed).

The list in `context.files_to_create` is still authoritative: create exactly
those files, no more. These conventions tell you what to PUT in a file the
list already names.
