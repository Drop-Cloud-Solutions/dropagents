/**
 * AP-VP6-001 — typed loader for the repo-root pipeline.yaml that selects
 * which IssueTracker and ChatGateway adapter the host bootstrap should
 * wire in.
 *
 * Background: a silent default-to-fake fall-through was a launch blocker —
 * the FakeAgentRunner got mounted merely because AGENT_RUNNER was unset,
 * with no operator-visible warning, so the pipeline ran everything through
 * fakes while looking perfectly healthy. The fix is to
 * make adapter selection *explicit* in a small top-level config file
 * with strict, enum-validated values and a single typed projection that
 * the rest of the host imports — so downstream wiring imports one
 * typed value instead of pulling two raw strings out of a generic YAML
 * mapping and re-validating in each call site.
 *
 * Schema (top-level keys on pipeline.yaml):
 *
 *   - issue_tracker  'linear' | 'fake'   (default 'fake')
 *   - chat_gateway   'telegram' | 'fake' (default 'fake')
 *
 * Both default to 'fake' so a fresh checkout boots without Linear or
 * Telegram credentials. Operators opt in by editing the file.
 *
 * Validation strictly rejects:
 *   - root that is not a YAML mapping
 *   - issue_tracker outside {linear, fake}
 *   - chat_gateway  outside {telegram, fake}
 *   - non-string values for either key
 *
 * Unknown values are NOT silently coerced — they raise
 * PipelineConfigError with the field name, the offending value, and the
 * allowed set, so an operator editing the YAML can correct the typo
 * without re-running the orchestrator to discover what went wrong.
 *
 * The loaded config exposes a typed `adapterSelection` projection
 * (camelCase) alongside the snake_case raw fields, so call sites can
 * import a single AdapterSelection value:
 *
 *   const { adapterSelection } = loadPipelineConfig('pipeline.yaml');
 *   wireIssueTracker(adapterSelection.issueTracker);
 *   wireChatGateway(adapterSelection.chatGateway);
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export type IssueTrackerSelection = 'linear' | 'fake';
export type ChatGatewaySelection = 'telegram' | 'fake';

const VALID_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerSelection> = ['linear', 'fake'];
const VALID_CHAT_GATEWAYS: ReadonlyArray<ChatGatewaySelection> = ['telegram', 'fake'];

export const DEFAULT_ISSUE_TRACKER: IssueTrackerSelection = 'fake';
export const DEFAULT_CHAT_GATEWAY: ChatGatewaySelection = 'fake';

/**
 * Typed projection of the two adapter-selection keys. Downstream wiring
 * imports this single value instead of re-reading the YAML keys.
 */
export interface AdapterSelection {
    readonly issueTracker: IssueTrackerSelection;
    readonly chatGateway: ChatGatewaySelection;
}

export interface PipelineConfig {
    readonly issue_tracker: IssueTrackerSelection;
    readonly chat_gateway: ChatGatewaySelection;
    /** Typed camelCase projection — preferred for downstream consumers. */
    readonly adapterSelection: AdapterSelection;
    /** Unvalidated remainder of the YAML mapping. Callers narrow as needed. */
    readonly raw: Readonly<Record<string, unknown>>;
}

export class PipelineConfigError extends Error {
    public readonly filePath: string;
    public readonly field?: string;

    constructor(filePath: string, detail: string, field?: string) {
        super(`${filePath}: ${detail}`);
        this.name = 'PipelineConfigError';
        this.filePath = filePath;
        this.field = field;
    }
}

export function loadPipelineConfig(filePath: string): PipelineConfig {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        throw new PipelineConfigError(
            filePath,
            `cannot read file: ${(err as Error).message}`,
        );
    }

    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch (err) {
        throw new PipelineConfigError(
            filePath,
            `malformed YAML: ${(err as Error).message}`,
        );
    }

    return parsePipelineConfig(filePath, doc);
}

/**
 * Validate an already-parsed YAML document. Exported separately so
 * callers that load the YAML through a different code path
 * (manager-api write validation, tests) can reuse the schema check
 * without a second disk read.
 */
export function parsePipelineConfig(filePath: string, doc: unknown): PipelineConfig {
    if (doc === null || doc === undefined) {
        // Empty file → all defaults apply.
        return buildConfig(DEFAULT_ISSUE_TRACKER, DEFAULT_CHAT_GATEWAY, {});
    }
    if (!isPlainObject(doc)) {
        throw new PipelineConfigError(filePath, 'root must be a YAML mapping');
    }

    const issueTracker = validateEnum(
        filePath,
        'issue_tracker',
        doc.issue_tracker,
        DEFAULT_ISSUE_TRACKER,
        VALID_ISSUE_TRACKERS,
    );
    const chatGateway = validateEnum(
        filePath,
        'chat_gateway',
        doc.chat_gateway,
        DEFAULT_CHAT_GATEWAY,
        VALID_CHAT_GATEWAYS,
    );

    return buildConfig(issueTracker, chatGateway, doc);
}

function buildConfig(
    issueTracker: IssueTrackerSelection,
    chatGateway: ChatGatewaySelection,
    raw: Record<string, unknown>,
): PipelineConfig {
    return {
        issue_tracker: issueTracker,
        chat_gateway: chatGateway,
        adapterSelection: { issueTracker, chatGateway },
        raw,
    };
}

function validateEnum<T extends string>(
    filePath: string,
    field: string,
    value: unknown,
    defaultValue: T,
    allowed: ReadonlyArray<T>,
): T {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== 'string') {
        throw new PipelineConfigError(
            filePath,
            `${field} must be a string (one of ${formatAllowed(allowed)}); got ${typeOf(value)}`,
            field,
        );
    }
    if (!allowed.includes(value as T)) {
        throw new PipelineConfigError(
            filePath,
            `${field}="${value}" is not allowed; expected one of ${formatAllowed(allowed)}`,
            field,
        );
    }
    return value as T;
}

function formatAllowed(allowed: ReadonlyArray<string>): string {
    return allowed.map((v) => `"${v}"`).join(', ');
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function typeOf(x: unknown): string {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array';
    return typeof x;
}
