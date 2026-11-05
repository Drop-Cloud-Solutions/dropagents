# Extra check: NuGet package flow

From the `dotnet-azure` stack pack. Audit this alongside the checks above.

**NuGet package flow** — your prompt includes the workspace's
`# NuGet package graph` block (publishers, consumers, required chain).
For EVERY sub-brief that modifies a repo listed as a package publisher
with cross-repo consumers, check the fan-out covers: publishing the
package after the change (`deploy-nuget`) AND bumping the reference in
each consuming repo whose work needs the new behaviour
(`bump-package-reference`), sequenced before that consumer's dependent
development.

A modified publisher whose publish/bump chain is absent from every brief is
a **blocker** — downstream plans would silently build against the old
package version (this exact miss shipped).
