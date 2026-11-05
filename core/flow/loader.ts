import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  FlowDefinition,
  FlowStartMode,
  FlowStep,
  FlowStepApproval,
  TaskTypeMeta,
} from './types';
import {
  FLOW_START_MODES,
  FLOW_STEP_APPROVALS,
  isFlowStartMode,
  isFlowStepApproval,
} from './types';

/**
 * YAML flow loader.
 *
 * `loadFlow(path)` parses a single `*.yaml` file into a validated
 * FlowDefinition. `loadAllFlows(dir)` recursively loads every `*.yaml`
 * under a directory and keys the result by the file's path relative to
 * `dir` (without extension, forward-slash separated).
 *
 * Validation rejects:
 *   - malformed YAML
 *   - missing required fields (`on`, `steps`, and per-step `id`/`agent`/
 *     `model`/`on_success`)
 *   - duplicate step ids inside a flow
 *   - transition targets that reference an unknown step id
 *   - steps unreachable from `steps[0]`
 *
 * All thrown errors include the file path so the offending flow can be
 * located without re-running the loader.
 */

const EMIT_PREFIX = 'emit:';
const YAML_FILE_RE = /\.yaml$/i;

class FlowLoadError extends Error {
  constructor(filePath: string, detail: string) {
    super(`${filePath}: ${detail}`);
    this.name = 'FlowLoadError';
  }
}

export function loadFlow(filePath: string): FlowDefinition {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new FlowLoadError(filePath, `cannot read file: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new FlowLoadError(filePath, `malformed YAML: ${(err as Error).message}`);
  }

  return validateFlow(filePath, doc);
}

export function loadAllFlows(dirPath: string): Map<string, FlowDefinition> {
  const flows = new Map<string, FlowDefinition>();
  for (const file of walkYaml(dirPath)) {
    const flow = loadFlow(file);
    const id = flowIdFromPath(dirPath, file);
    if (flows.has(id)) {
      throw new Error(`duplicate flow id "${id}" (from ${file})`);
    }
    flows.set(id, flow);
  }
  return flows;
}

/**
 * Hot-reload: re-run the full loader pass over `dirPath` and swap the result
 * INTO `target` in place. The FlowEngine holds its flow map by reference and
 * does a live `.get()` per dispatch, so mutating that same Map is what makes
 * an operator "Apply" take effect without an engine restart.
 *
 * Atomic on failure: the fresh load happens into a NEW map first, so a
 * malformed flow on disk throws and leaves `target` (the running config)
 * untouched. Tasks mid-flow are unaffected until their next step lookup,
 * which then sees the new definitions.
 */
export function reloadAllFlowsInto(
  target: Map<string, FlowDefinition>,
  dirPath: string,
): { flowIds: string[] } {
  const fresh = loadAllFlows(dirPath); // throws before target is touched
  target.clear();
  for (const [id, def] of fresh) target.set(id, def);
  return { flowIds: [...fresh.keys()] };
}

/**
 * Load flows from several directories, lowest precedence first. A flow id
 * in a later directory REPLACES the same id from an earlier one — that is
 * how an operator's profile overrides a repo default flow without editing a
 * tracked file. Duplicate ids WITHIN one directory still throw, exactly as
 * {@link loadAllFlows} does. Missing directories are skipped.
 */
export function loadLayeredFlows(dirPaths: readonly string[]): Map<string, FlowDefinition> {
  const flows = new Map<string, FlowDefinition>();
  for (const dir of dirPaths) {
    if (!fs.existsSync(dir)) continue;
    for (const [id, def] of loadAllFlows(dir)) flows.set(id, def);
  }
  return flows;
}

/** {@link reloadAllFlowsInto} over layered directories. Same atomicity. */
export function reloadLayeredFlowsInto(
  target: Map<string, FlowDefinition>,
  dirPaths: readonly string[],
): { flowIds: string[] } {
  const fresh = loadLayeredFlows(dirPaths); // throws before target is touched
  target.clear();
  for (const [id, def] of fresh) target.set(id, def);
  return { flowIds: [...fresh.keys()] };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateFlow(filePath: string, doc: unknown): FlowDefinition {
  if (!isPlainObject(doc)) {
    throw new FlowLoadError(filePath, 'flow root must be a YAML mapping');
  }

  const on = doc.on;
  if (typeof on !== 'string' || on.length === 0) {
    throw new FlowLoadError(filePath, 'missing required field "on" (event type string)');
  }

  const whenRaw = doc.when;
  let when: string | undefined;
  if (whenRaw !== undefined && whenRaw !== null) {
    if (typeof whenRaw !== 'string') {
      throw new FlowLoadError(filePath, 'field "when" must be a string predicate');
    }
    when = whenRaw;
  }

  const startModeRaw = doc.start_mode;
  let start_mode: FlowStartMode | undefined;
  if (startModeRaw !== undefined && startModeRaw !== null) {
    if (typeof startModeRaw !== 'string' || !isFlowStartMode(startModeRaw)) {
      const allowed = Object.values(FLOW_START_MODES).map((v) => `"${v}"`).join(', ');
      throw new FlowLoadError(
        filePath,
        `field "start_mode" must be one of ${allowed} (got ${JSON.stringify(startModeRaw)})`,
      );
    }
    start_mode = startModeRaw;
  }

  const stepsRaw = doc.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new FlowLoadError(filePath, 'field "steps" must be a non-empty array');
  }

  const steps: FlowStep[] = stepsRaw.map((entry, index) =>
    validateStep(filePath, entry, index)
  );

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new FlowLoadError(filePath, `duplicate step id "${step.id}"`);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    validateTransition(filePath, step, 'on_success', step.on_success, ids);
    if (step.on_question !== undefined) {
      validateTransition(filePath, step, 'on_question', step.on_question, ids);
    }
    if (step.on_failure !== undefined) {
      validateTransition(filePath, step, 'on_failure', step.on_failure, ids);
    }
  }

  const unreachable = findUnreachable(steps);
  if (unreachable.length > 0) {
    throw new FlowLoadError(
      filePath,
      `unreachable steps from entry "${steps[0].id}": ${unreachable.join(', ')}`
    );
  }

  const task_type = validateTaskType(filePath, doc.task_type);

  const base: FlowDefinition =
    when !== undefined ? { on, when, steps } : { on, steps };
  return {
    ...base,
    ...(start_mode !== undefined ? { start_mode } : {}),
    ...(task_type !== undefined ? { task_type } : {}),
  };
}

const TASK_TYPE_KEYS: ReadonlySet<string> = new Set([
  'label', 'decomposable', 'writes_code', 'worktree', 'add_task', 'produces_report',
  'chat_proposable', 'synonyms',
]);

/**
 * Strict on purpose: a misspelt key (`writes-code`) would otherwise read
 * as "false" and quietly drop a type from the verify gate or the
 * decomposer's allowed set — the silent-mismatch class this block exists
 * to end.
 */
function validateTaskType(filePath: string, raw: unknown): TaskTypeMeta | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new FlowLoadError(filePath, 'field "task_type" must be a mapping');
  }
  for (const key of Object.keys(raw)) {
    if (!TASK_TYPE_KEYS.has(key)) {
      throw new FlowLoadError(
        filePath,
        `unknown field "task_type.${key}" (allowed: ${[...TASK_TYPE_KEYS].join(', ')})`,
      );
    }
  }
  const bool = (key: string): boolean => {
    const v = raw[key];
    if (v === undefined) return false;
    if (typeof v !== 'boolean') {
      throw new FlowLoadError(filePath, `field "task_type.${key}" must be true or false`);
    }
    return v;
  };
  const label = raw.label;
  if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0)) {
    throw new FlowLoadError(filePath, 'field "task_type.label" must be a non-empty string');
  }
  const worktree = raw.worktree ?? 'task';
  if (worktree !== 'task' && worktree !== 'shared-deploy' && worktree !== 'workspace-root') {
    throw new FlowLoadError(
      filePath,
      'field "task_type.worktree" must be "task", "shared-deploy" or "workspace-root" '
      + `(got ${JSON.stringify(worktree)})`,
    );
  }
  return {
    ...(typeof label === 'string' ? { label } : {}),
    decomposable: bool('decomposable'),
    writes_code: bool('writes_code'),
    worktree,
    add_task: bool('add_task'),
    produces_report: bool('produces_report'),
    chat_proposable: bool('chat_proposable'),
    synonyms: validateSynonyms(filePath, raw.synonyms),
  };
}

/**
 * `task_type.synonyms` — the words the chat assistant's `Type:` field may
 * carry for this type. Normalised to lower case here so the parser can
 * match without re-normalising, and duplicates within one flow are an
 * error: they mean someone listed the same alias twice and expected
 * something from it.
 */
function validateSynonyms(filePath: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new FlowLoadError(filePath, 'field "task_type.synonyms" must be a list');
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new FlowLoadError(
        filePath,
        'field "task_type.synonyms" must be a list of non-empty strings',
      );
    }
    const word = entry.trim().toLowerCase();
    if (out.includes(word)) {
      throw new FlowLoadError(filePath, `field "task_type.synonyms" lists "${word}" twice`);
    }
    out.push(word);
  }
  return out;
}

function validateStep(filePath: string, raw: unknown, index: number): FlowStep {
  if (!isPlainObject(raw)) {
    throw new FlowLoadError(filePath, `steps[${index}] must be a mapping`);
  }

  const id = requireString(filePath, raw.id, `steps[${index}].id`);
  const agent = requireString(filePath, raw.agent, `steps[${index}] (id="${id}").agent`);
  const model = requireString(filePath, raw.model, `steps[${index}] (id="${id}").model`);
  const on_success = requireString(
    filePath,
    raw.on_success,
    `steps[${index}] (id="${id}").on_success`
  );

  const on_question =
    raw.on_question === undefined || raw.on_question === null
      ? undefined
      : requireString(filePath, raw.on_question, `steps[${index}] (id="${id}").on_question`);

  const on_failure =
    raw.on_failure === undefined || raw.on_failure === null
      ? undefined
      : requireString(filePath, raw.on_failure, `steps[${index}] (id="${id}").on_failure`);

  let params: Record<string, unknown> | undefined;
  if (raw.params !== undefined && raw.params !== null) {
    if (!isPlainObject(raw.params)) {
      throw new FlowLoadError(
        filePath,
        `steps[${index}] (id="${id}").params must be a mapping`,
      );
    }
    params = raw.params;
  }

  let approval: FlowStepApproval | undefined;
  if (raw.approval !== undefined && raw.approval !== null) {
    if (typeof raw.approval !== 'string' || !isFlowStepApproval(raw.approval)) {
      const allowed = Object.values(FLOW_STEP_APPROVALS).map((v) => `"${v}"`).join(', ');
      throw new FlowLoadError(
        filePath,
        `step "${id}".approval must be one of ${allowed} (got ${JSON.stringify(raw.approval)})`,
      );
    }
    approval = raw.approval;
  }

  return { id, agent, model, on_success, on_question, on_failure, params, approval };
}

function validateTransition(
  filePath: string,
  step: FlowStep,
  field: 'on_success' | 'on_question' | 'on_failure',
  target: string,
  knownIds: ReadonlySet<string>
): void {
  if (target.startsWith(EMIT_PREFIX)) {
    if (target.length === EMIT_PREFIX.length) {
      throw new FlowLoadError(
        filePath,
        `step "${step.id}".${field} has empty emit target ("emit:")`
      );
    }
    return;
  }
  if (!knownIds.has(target)) {
    throw new FlowLoadError(
      filePath,
      `step "${step.id}".${field} references unknown step id "${target}"`
    );
  }
}

function findUnreachable(steps: readonly FlowStep[]): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const reachable = new Set<string>();
  const queue: string[] = [steps[0].id];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);

    const step = byId.get(id);
    if (!step) continue;
    for (const target of [step.on_success, step.on_question, step.on_failure]) {
      if (!target || target.startsWith(EMIT_PREFIX)) continue;
      if (!reachable.has(target)) queue.push(target);
    }
  }

  return steps.filter((s) => !reachable.has(s.id)).map((s) => s.id);
}

function requireString(filePath: string, val: unknown, field: string): string {
  if (typeof val !== 'string' || val.length === 0) {
    throw new FlowLoadError(filePath, `missing required field "${field}" (non-empty string)`);
  }
  return val;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function walkYaml(dirPath: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkYaml(full));
    } else if (entry.isFile() && YAML_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  out.sort();
  return out;
}

function flowIdFromPath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath).replace(YAML_FILE_RE, '');
  return rel.split(path.sep).join('/');
}
