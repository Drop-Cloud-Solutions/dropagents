# Cross-repo references (NuGet vs ProjectReference)

From the `dotnet-azure` stack pack.

When you add a new project reference in a `.csproj`, **the choice between
`<PackageReference>` and `<ProjectReference>` is not stylistic — it's structural**.
Get this wrong and the build either fails immediately (cross-repo `<ProjectReference>`
is invalid) or compiles locally but breaks for everyone else.

If the task brief includes a **"Cross-repo NuGet packages"** section near the
bottom, that's the authoritative list of packages this project's repos publish.
Read it before writing any reference.

Decision tree:

1. **Need a type/service from a project in the SAME `.sln`?**
   Use `<ProjectReference Include="..\Other\Other.csproj" />`.

2. **Need a type/service from a project in a DIFFERENT repo / solution?**
   Use `<PackageReference Include="<package-id>" Version="<latest>" />`. Look up the
   `<package-id>` in the "Cross-repo NuGet packages" section of TASK.md.
   If the package id you need isn't in that list, **stop and use the
   NEEDS_HUMAN_INPUT escape hatch** — don't invent a package id, and don't fall back
   to a relative-path `<ProjectReference>` across repos.

3. **Adding a brand-new `.csproj` (scaffold)?** Same rules. Same-solution refs go
   through `<ProjectReference>`; everything else through `<PackageReference>` to the
   NuGet feed. Follow the CLAUDE.md guidance for whether the new project is itself
   publishable (sibling `nuget_package_publish.ps1`). If yes, scaffold the publish
   script alongside the project — the orchestrator's auto-detect picks publishers
   up by that marker file.

You do not need to hand-bump versions when an upstream package is republished.
The orchestrator inserts an automatic `bump-package-reference` task as part of
the deploy chain, and that task runs `dotnet add package` against your `.csproj`
without `--version` (resolves to whatever the upstream just shipped).
