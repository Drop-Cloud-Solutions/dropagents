/**
 * Adapter: cron-driven scheduled task subscriber.
 *
 * Loads a YAML schedule file describing periodic flow triggers and registers
 * an in-process subscriber that, on each cron-matching minute, dispatches
 * `CreateTask` through the supplied `CommandBus`. The handler downstream of
 * `CreateTask` emits `TaskCreated`, so each fire ultimately produces a
 * `TaskCreated` event in the event log.
 *
 * Cron parsing supports the standard five-field format
 *
 *     minute hour day-of-month month day-of-week
 *
 * with `*`, lists (`a,b`), ranges (`a-b`), and steps (`* /n`, `a-b/n`).
 * Day-of-month / day-of-week semantics follow the Vixie-cron convention:
 * when both fields are restricted (neither is `*`), the entry fires when
 * EITHER matches; otherwise both must match. All time arithmetic is in
 * UTC so behaviour is deterministic across host timezones — schedules.yaml
 * documents this trade-off.
 *
 * Invalid cron expressions for an entry are logged and that entry is
 * skipped; the rest of the schedule list still registers (AC #5).
 *
 * The default tick interval is 60s (cron's native resolution). Per-entry
 * deduplication keys on `Math.floor(now / 60_000)`, so even if the timer
 * fires multiple times within the same minute the entry is dispatched at
 * most once per minute. The deduplication state lives in-process — a host
 * restart resets it, which is acceptable for the usage targeted by
 * AP-NVP-041 (no exactly-once requirement across crashes).
 */

import * as fs from 'fs';

import * as yaml from 'js-yaml';

import type { CommandBus } from '../../core/commands/bus';
import type { Logger } from '../../core/ports/Logger';

export interface ScheduleEntry {
    readonly name: string;
    readonly cron: string;
    readonly projectId: string;
    readonly flow: string;
    readonly payload?: unknown;
}

export interface SchedulerOptions {
    readonly commandBus: CommandBus<unknown>;
    readonly schedules: ReadonlyArray<ScheduleEntry>;
    readonly logger: Logger;
    /** Clock override for tests. Defaults to `Date.now`. */
    readonly clock?: () => number;
    /** Tick period in milliseconds. Defaults to 60_000 (1 minute). */
    readonly tickIntervalMs?: number;
    /** Start the recurring timer. Defaults to true; tests pass false. */
    readonly startTimer?: boolean;
    /** `actor` value put on each dispatched command. Defaults to `cron-scheduler`. */
    readonly actor?: string;
}

export interface SchedulerHandle {
    /**
     * Run a single check cycle. With `now` omitted the registered clock is
     * read; tests pass an explicit value to drive the scheduler against a
     * fake clock.
     */
    tick(now?: number): Promise<void>;
    /** Cancel the recurring timer. Idempotent. */
    stop(): void;
}

export const SCHEDULER_ACTOR = 'cron-scheduler';
const DEFAULT_TICK_MS = 60_000;

interface ParsedCron {
    readonly minute: ReadonlySet<number>;
    readonly hour: ReadonlySet<number>;
    readonly dom: ReadonlySet<number>;
    readonly month: ReadonlySet<number>;
    readonly dow: ReadonlySet<number>;
    readonly domRestricted: boolean;
    readonly dowRestricted: boolean;
}

interface RegisteredEntry {
    readonly entry: ScheduleEntry;
    readonly fields: ParsedCron;
    /** `Math.floor(timestampMs / 60_000)` of the most recent fire, or -1. */
    lastFiredMinute: number;
}

/**
 * Parse `file` as a YAML array of `ScheduleEntry`. A missing or empty file
 * yields `[]`. A non-array top-level document throws — that's a config bug
 * the operator should fix, not something to silently swallow.
 */
export function load(file: string): ScheduleEntry[] {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return [];
        throw err;
    }
    const parsed = yaml.load(raw) as unknown;
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed)) {
        throw new Error(
            `scheduler.load: expected a YAML sequence at the top level of ${file}`,
        );
    }
    const out: ScheduleEntry[] = [];
    for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        out.push({
            name: String(o.name ?? ''),
            cron: String(o.cron ?? ''),
            projectId: String(o.projectId ?? ''),
            flow: String(o.flow ?? ''),
            payload: o.payload,
        });
    }
    return out;
}

/**
 * Register the cron subscriber. Returns a handle exposing `tick()` (used by
 * tests to drive the scheduler against a fake clock) and `stop()` (cancels
 * the recurring timer). Entries with malformed cron expressions are logged
 * and skipped; the rest still register.
 */
export function register(options: SchedulerOptions): SchedulerHandle {
    const clock = options.clock ?? ((): number => Date.now());
    const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    const startTimer = options.startTimer ?? true;
    const actor = options.actor ?? SCHEDULER_ACTOR;

    const registered: RegisteredEntry[] = [];
    for (const entry of options.schedules) {
        try {
            const fields = parseCron(entry.cron);
            registered.push({ entry, fields, lastFiredMinute: -1 });
        } catch (err) {
            options.logger.warn(
                'cron-scheduler: invalid cron expression, skipping entry',
                {
                    name: entry.name,
                    cron: entry.cron,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
        }
    }

    const tick = async (nowMs?: number): Promise<void> => {
        const now = nowMs ?? clock();
        const date = new Date(now);
        const minuteKey = Math.floor(now / 60_000);
        for (const r of registered) {
            if (r.lastFiredMinute === minuteKey) continue;
            if (!cronMatches(r.fields, date)) continue;
            r.lastFiredMinute = minuteKey;
            try {
                await options.commandBus.send({
                    type: 'CreateTask',
                    actor,
                    issuedAt: now,
                    payload: {
                        planId: `cron:${r.entry.name}`,
                        taskType: r.entry.flow,
                        flowId: r.entry.flow,
                        projectId: r.entry.projectId,
                        scheduleName: r.entry.name,
                        schedulePayload: r.entry.payload,
                    },
                });
            } catch (err) {
                options.logger.error('cron-scheduler: dispatch failed', {
                    name: r.entry.name,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    };

    let timer: NodeJS.Timeout | undefined;
    if (startTimer) {
        timer = setInterval(() => {
            void tick();
        }, tickIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    return {
        tick,
        stop(): void {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
    };
}

// ---------------- cron parser ----------------

function parseCron(expr: string): ParsedCron {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`expected 5 fields, got ${fields.length}`);
    }
    return {
        minute: parseField(fields[0], 0, 59),
        hour: parseField(fields[1], 0, 23),
        dom: parseField(fields[2], 1, 31),
        month: parseField(fields[3], 1, 12),
        dow: parseField(fields[4], 0, 6),
        domRestricted: fields[2] !== '*',
        dowRestricted: fields[4] !== '*',
    };
}

function parseField(field: string, min: number, max: number): Set<number> {
    if (field.length === 0) {
        throw new Error('empty field');
    }
    const out = new Set<number>();
    for (const part of field.split(',')) {
        let stepStr = '1';
        let rangePart = part;
        const slash = part.indexOf('/');
        if (slash >= 0) {
            rangePart = part.slice(0, slash);
            stepStr = part.slice(slash + 1);
        }
        const step = Number.parseInt(stepStr, 10);
        if (!Number.isInteger(step) || step <= 0 || String(step) !== stepStr) {
            throw new Error(`invalid step "${stepStr}" in "${field}"`);
        }
        let lo: number;
        let hi: number;
        if (rangePart === '*' || rangePart === '') {
            lo = min;
            hi = max;
        } else if (rangePart.includes('-')) {
            const dash = rangePart.indexOf('-');
            const aStr = rangePart.slice(0, dash);
            const bStr = rangePart.slice(dash + 1);
            lo = Number.parseInt(aStr, 10);
            hi = Number.parseInt(bStr, 10);
            if (
                !Number.isInteger(lo) ||
                !Number.isInteger(hi) ||
                String(lo) !== aStr ||
                String(hi) !== bStr
            ) {
                throw new Error(`invalid range "${rangePart}" in "${field}"`);
            }
        } else {
            const n = Number.parseInt(rangePart, 10);
            if (!Number.isInteger(n) || String(n) !== rangePart) {
                throw new Error(`invalid value "${rangePart}" in "${field}"`);
            }
            lo = n;
            hi = n;
        }
        if (lo < min || hi > max || lo > hi) {
            throw new Error(
                `range "${lo}-${hi}" out of bounds [${min},${max}] in "${field}"`,
            );
        }
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
}

function cronMatches(c: ParsedCron, date: Date): boolean {
    if (!c.minute.has(date.getUTCMinutes())) return false;
    if (!c.hour.has(date.getUTCHours())) return false;
    if (!c.month.has(date.getUTCMonth() + 1)) return false;

    const domMatch = c.dom.has(date.getUTCDate());
    const dowMatch = c.dow.has(date.getUTCDay());
    if (c.domRestricted && c.dowRestricted) {
        return domMatch || dowMatch;
    }
    return domMatch && dowMatch;
}
