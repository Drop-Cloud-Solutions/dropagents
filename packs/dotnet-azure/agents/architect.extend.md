# NuGet package flow (HARD)

From the `dotnet-azure` stack pack.

Your prompt includes the workspace's `# NuGet package graph` block —
publishers, consumers, and the required publish/bump chain. Consumers pin
published package VERSIONS, so changing a publisher's source does NOTHING for
its consumers until the package is published and each consumer's reference is
bumped.

Whenever any sub-brief modifies a repo that publishes a package with
consumers, the design and the affected sub-briefs MUST spell out: publish the
package after the publisher's change (`deploy-nuget`), then bump the reference
in every consuming repo whose work depends on the new behaviour
(`bump-package-reference`) BEFORE that consumer's dependent development.

Omitting this chain is the field failure this rule exists for: downstream
plans silently built against the old package.
