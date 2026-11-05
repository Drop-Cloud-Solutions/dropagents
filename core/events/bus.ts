import { EventEmitter } from 'node:events';
import type { Logger } from '../ports/Logger';
import type { EventStore } from './store';
import type { Event, StoredEvent } from './event';

/**
 * Handler invoked for each delivered event. Handlers may be async; the bus
 * awaits each one sequentially per event so causal ordering is preserved.
 */
export type EventHandler<TPayload = unknown> = (
    event: StoredEvent & { payload: TPayload },
) => void | Promise<void>;

export interface SubscribeOptions {
    /**
     * Named subscribers participate in offset tracking and can replay missed
     * events on boot via `replayMissed`. Anonymous subscribers (no name)
     * receive live events but their progress is not persisted, so they cannot
     * recover from downtime.
     */
    subscriber?: string;
}

interface Subscription {
    type: string;
    handler: EventHandler;
    subscriber: string | undefined;
}

/**
 * Typed in-process pub/sub layer over Node's EventEmitter.
 *
 * `publish` persists every event through the supplied EventStore BEFORE
 * fanning out to subscribers. If `EventStore.append` throws, no subscriber
 * is notified and the error propagates to the caller — persistence and
 * delivery are transactional in spirit.
 *
 * Handlers run sequentially per event in registration order. An exception
 * in one handler is logged and isolated — later handlers still run.
 *
 * Named subscribers advance their offset after each successful handler
 * invocation. `replayMissed` reads from the persisted offset and re-delivers
 * any events the subscriber has not yet seen; handlers must therefore be
 * idempotent.
 */
export class EventBus {
    private readonly emitter = new EventEmitter();
    private readonly subscriptions = new Map<EventHandler, Subscription>();
    private readonly allHandlers = new Set<(event: StoredEvent) => void | Promise<void>>();

    constructor(
        private readonly store: EventStore,
        private readonly logger: Logger,
    ) {
        // Unbounded — a single bus may host many subscriptions across the app.
        this.emitter.setMaxListeners(0);
    }

    /**
     * Persist the event, then deliver it to every matching subscriber in
     * registration order. Returns the stored event (with its assigned seq).
     *
     * If `EventStore.append` throws, the error propagates and no subscriber
     * is invoked.
     *
     * After per-type fan-out, every event is also delivered to handlers
     * registered through `subscribeAll`. These handlers are intentionally
     * isolated from the typed subscription path: they receive every event
     * regardless of type and exist for cross-cutting consumers (HTTP
     * Server-Sent Events, audit forwarders) that should not need to know
     * the full event vocabulary up-front. Errors are isolated and logged.
     */
    async publish(event: Event): Promise<StoredEvent> {
        const seq = this.store.append(event);
        const stored: StoredEvent = { ...event, seq };
        // Forward to subscribeAll handlers BEFORE dispatching to type-
        // scoped subscribers. A subscriber may publish further events
        // synchronously (e.g. the TaskCreated → task.created bridge
        // → flow-engine.onTaskCreated → publishTaskParked chain) and
        // those nested publishes are awaited inside `dispatch`. If we
        // ran allHandlers AFTER dispatch, the outermost event's SSE
        // frame would arrive AFTER every nested frame — board sees
        // TaskParked, task.created, TaskCreated in that order, drops
        // TaskParked because TaskCreated hasn't created the in-memory
        // row yet, then never re-receives parked_reason. Forwarding
        // first preserves the seq-ordering on the wire so reducers
        // see causally-correct state.
        for (const handler of this.allHandlers) {
            try {
                await handler(stored);
            } catch (err) {
                this.logger.error('subscribeAll handler threw', {
                    type: stored.type,
                    seq: stored.seq,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        await this.dispatch(stored, () => true);
        return stored;
    }

    /**
     * Register a handler that receives every published event regardless of
     * type. Returns an unsubscribe function. Unlike `subscribe`, these
     * handlers are anonymous — no offset is tracked and there is no replay.
     * Intended for live forwarders (SSE streams, dev consoles).
     */
    subscribeAll(handler: (event: StoredEvent) => void | Promise<void>): () => void {
        this.allHandlers.add(handler);
        return () => {
            this.allHandlers.delete(handler);
        };
    }

    /**
     * Register a handler for events of `type`. Returns an unsubscribe function
     * that detaches the handler.
     *
     * Anonymous subscriptions receive live events but are not tracked for
     * replay. Named subscriptions (`opts.subscriber`) advance the persisted
     * offset after each successful handler invocation.
     */
    subscribe<TPayload = unknown>(
        type: string,
        handler: EventHandler<TPayload>,
        opts: SubscribeOptions = {},
    ): () => void {
        const erased = handler as EventHandler;
        const sub: Subscription = { type, handler: erased, subscriber: opts.subscriber };
        this.subscriptions.set(erased, sub);
        this.emitter.on(type, erased);
        return () => {
            this.emitter.off(type, erased);
            this.subscriptions.delete(erased);
        };
    }

    /**
     * Replay any events past the subscriber's current offset to its
     * registered handlers, in seq order, up to the log tip snapshotted at
     * call time.
     *
     * The offset advances once per read batch (and jumps to the snapshot
     * tip at the end), even when no handler is registered for an event's
     * type — otherwise replay would stall on uninteresting events.
     * `advanceSubscriberOffset` is monotonic so duplicate advances are
     * harmless.
     *
     * `opts.skipTypes` excludes event types from the scan entirely (in
     * SQL): streaming telemetry (AgentActivity/AgentProgress) is ~80% of a
     * mature log and nothing folds it historically — a skipped type is
     * still offset-jumped past.
     *
     * Handlers must be idempotent: a handler that failed during the
     * original publish (offset not advanced) will be re-invoked here, and
     * a crash mid-batch redelivers up to a batch of events on next boot.
     */
    async replayMissed(
        subscriberName: string,
        opts: { readonly skipTypes?: readonly string[] } = {},
    ): Promise<void> {
        const BATCH = 256;
        const skipTypes = opts.skipTypes ?? [];
        // Snapshot the upper bound BEFORE scanning. Events published after
        // this point are live-dispatched to the (already registered)
        // subscriber through the normal path, so the final offset jump to
        // maxSeq below cannot skip anything undelivered.
        const maxSeq = this.store.maxSeq();
        if (maxSeq === 0) return;
        for (;;) {
            const offset = this.store.getSubscriberOffset(subscriberName);
            if (offset >= maxSeq) return;
            const events = this.store.readForReplay(offset, maxSeq, BATCH, skipTypes);
            if (events.length === 0) break;
            for (const ev of events) {
                await this.dispatch(
                    ev,
                    (sub) => sub.subscriber === subscriberName,
                    // Offsets advance ONCE per batch (below), not per
                    // handler invocation: per-event UPSERTs made a
                    // first-boot replay O(events) sqlite writes per
                    // subscriber and dominated worker boot time (2m14s at
                    // 85k events, field incident). A crash mid-batch
                    // redelivers at most BATCH events; handlers are
                    // idempotent by contract.
                    { advanceOffset: false },
                );
            }
            this.store.advanceSubscriberOffset(
                subscriberName,
                events[events.length - 1]!.seq,
            );
        }
        // Jump past any skipped (or trailing already-delivered) events so
        // the next boot's scan starts at the snapshot tip.
        this.store.advanceSubscriberOffset(subscriberName, maxSeq);
    }

    /**
     * Fan out a single event to every listener registered for its type that
     * also satisfies `match`. Snapshots the listener list up-front so that
     * subscribes/unsubscribes during dispatch do not change the delivery set
     * for this event.
     */
    private async dispatch(
        event: StoredEvent,
        match: (sub: Subscription) => boolean,
        opts: { readonly advanceOffset?: boolean } = {},
    ): Promise<void> {
        const listeners = this.emitter.listeners(event.type) as EventHandler[];
        for (const listener of listeners) {
            const sub = this.subscriptions.get(listener);
            if (!sub) continue;
            if (!match(sub)) continue;
            try {
                await sub.handler(event);
                if (sub.subscriber && opts.advanceOffset !== false) {
                    this.store.advanceSubscriberOffset(sub.subscriber, event.seq);
                }
            } catch (err) {
                this.logger.error('event handler threw', {
                    type: event.type,
                    seq: event.seq,
                    subscriber: sub.subscriber ?? null,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}
