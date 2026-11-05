# .NET / NuGet / Azure design considerations

From the `dotnet-azure` stack pack. These apply on top of the general
placement and design rules above, whenever the plan touches this stack.

## Cross-repo package releases

A change to a **published** library is a cross-repo release: consumers pin
package VERSIONS, so they only see the fix after a new package version is
published AND their reference is bumped. Name the package and the consuming
repos in `## Integration Points`. The decomposer emits the publish
(`deploy-nuget`) and version-bump (`bump-package-reference`) chain — do not
enumerate those tasks yourself.

Dependency direction still holds: a business repo may consume a framework
library; a framework library must never depend on a business repo.

## New projects and publishable repos

**A new sub-project inside an existing repo** is a new `.csproj`. Give the
directory, the project file path, the kind (library / test / host), what
references it, and what it references. List the `.csproj` itself under
`## Key Files` marked `(new)`.

**A brand-new repo**: say whether it publishes a NuGet package, and if it
does, include the publish script (`nuget_package_publish.ps1`) in the
initial file set alongside the solution, csproj and README. State the tier
(`api` / `frontend-lib` / `app` / `infra` / `shared`) — the package graph
and the decomposer's hints key off it.

## Tech-stack specific considerations

Apply these automatically when the tech appears in the stack. Frame them as
**architectural choices**, not line-by-line checklist items.

### `dotnet8`
- File-scoped namespaces, records for DTOs, primary constructors acceptable for simple services
- Nullable reference types enabled

### `azure-functions-v4`
- Isolated worker model, not in-process
- HTTP triggers use `[Function]` + `[HttpTrigger]`, return `HttpResponseData` or typed result pattern
- DI registration in `Program.cs` — mention any new service registrations

### `cosmos-db`
- Call out the partition key decision explicitly in "Data Model Changes"
- Pagination via continuation tokens, not OFFSET/LIMIT
- Container/database names from `IConfiguration`
- Wrap `CosmosException` at the repository boundary

### `duende-identity`
- State client type (browser/confidential), PKCE requirements, refresh token needs
- Token lifetimes read from config

### `xunit`
- Note that tests are bundled with implementation tasks, not separate
- Specify test categories (`Category=Unit` or `Category=Integration`) when mentioning test coverage in the approach

### `blazor-wasm`
- Mention which composite app hosts the change
- Opt-in provider pattern for cross-domain features
- E2E tests via Playwright, component tests via bUnit
