/**
 * Typed loader for `config/pipeline.yaml`.
 *
 * `loadPipelineConfig(path)` parses the YAML, validates the schema, and
 * returns a `PipelineConfig` with the routing-relevant fields normalised:
 *
 *   - `issue_tracker`         'linear' | 'jira'           (default 'linear')
 *   - `issue_tracker_shadow`  'none' | 'linear' | 'jira'  (default 'none')
 *
 * Validation rejects:
 *   - root that is not a YAML mapping
 *   - `issue_tracker` set to anything outside the {linear, jira} set
 *   - `issue_tracker_shadow` set to anything outside the {none, linear, jira} set
 *   - `issue_tracker_shadow` equal to `issue_tracker` (redundant mirror)
 *
 * The validated subset is exposed on the returned object; unrelated keys
 * (config_store, default_models, ...) flow through as `unknown` and the
 * caller projects them with its own type-narrowing.
 *
 * Errors include the file path and the offending value so an operator
 * editing the YAML can correct it without re-running the orchestrator.
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export type IssueTrackerKind = 'linear' | 'jira';
export type IssueTrackerShadowKind = 'none' | 'linear' | 'jira';

const VALID_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerKind> = ['linear', 'jira'];
const VALID_SHADOWS: ReadonlyArray<IssueTrackerShadowKind> = ['none', 'linear', 'jira'];

export const DEFAULT_ISSUE_TRACKER: IssueTrackerKind = 'linear';
export const DEFAULT_ISSUE_TRACKER_SHADOW: IssueTrackerShadowKind = 'none';

export interface PipelineConfig {
  readonly issue_tracker: IssueTrackerKind;
  readonly issue_tracker_shadow: IssueTrackerShadowKind;
  /** Unvalidated remainder of the YAML mapping. Callers narrow as needed. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export class PipelineConfigError extends Error {
  constructor(filePath: string, detail: string) {
    super(`${filePath}: ${detail}`);
    this.name = 'PipelineConfigError';
  }
}

export function loadPipelineConfig(filePath: string): PipelineConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new PipelineConfigError(filePath, `cannot read file: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new PipelineConfigError(filePath, `malformed YAML: ${(err as Error).message}`);
  }

  return parsePipelineConfig(filePath, doc);
}

/**
 * Validate an already-parsed YAML document. Exported separately so callers
 * that load the YAML through a different code path (manager-api write
 * validation, tests) can re-use the schema check without a second disk read.
 */
export function parsePipelineConfig(filePath: string, doc: unknown): PipelineConfig {
  if (doc === null || doc === undefined) {
    // Empty file → all defaults apply.
    return {
      issue_tracker: DEFAULT_ISSUE_TRACKER,
      issue_tracker_shadow: DEFAULT_ISSUE_TRACKER_SHADOW,
      raw: {},
    };
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
  const shadow = validateEnum(
    filePath,
    'issue_tracker_shadow',
    doc.issue_tracker_shadow,
    DEFAULT_ISSUE_TRACKER_SHADOW,
    VALID_SHADOWS,
  );

  // `packs:` — stack packs to enable (config/packs.ts). Only the SHAPE is
  // checked here; whether each id exists is the pack loader's job, which
  // needs the filesystem this module does not touch.
  const packs = doc.packs;
  if (packs !== undefined && packs !== null
      && (!Array.isArray(packs) || packs.some((p) => typeof p !== 'string' || p.length === 0))) {
    throw new PipelineConfigError(filePath, 'field "packs" must be a list of pack ids');
  }

  if (shadow !== 'none' && shadow === issueTracker) {
    throw new PipelineConfigError(
      filePath,
      `issue_tracker_shadow="${shadow}" must differ from issue_tracker="${issueTracker}" ` +
        `(a tracker cannot shadow itself)`,
    );
  }

  return {
    issue_tracker: issueTracker,
    issue_tracker_shadow: shadow,
    raw: doc,
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
      `${field} must be a string (one of ${allowed.map((v) => `"${v}"`).join(', ')}); ` +
        `got ${typeOf(value)}`,
    );
  }
  if (!allowed.includes(value as T)) {
    throw new PipelineConfigError(
      filePath,
      `${field}="${value}" is not allowed; expected one of ${allowed.map((v) => `"${v}"`).join(', ')}`,
    );
  }
  return value as T;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function typeOf(x: unknown): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}
