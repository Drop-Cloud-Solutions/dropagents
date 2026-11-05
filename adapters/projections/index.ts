/**
 * Barrel module for the v2 projection adapters.
 *
 * Production hosts construct one of each store against the shared
 * `EventBus` + SQLite handle on boot; tests construct stores directly
 * so the subscriber wiring can be observed in isolation. Re-exporting
 * the public surface from a single entry point keeps host wiring code
 * free of per-adapter relative-import noise.
 */

export {
    SqliteDecomposeStatusStore,
    DECOMPOSE_EVENT_TYPES,
    foldRowsToSnapshot,
} from './decompose-status-store';
export {
    PlanReviewStore,
    PLAN_REVIEW_EVENT_TYPES,
    PLAN_REVIEW_PROJECTION_SUBSCRIBER,
    type PendingPlanReview,
    type PlanReviewRevision,
} from './plan-review-store';
export {
    TaskProjectionStore,
    TASK_PROJECTION_SUBSCRIBER,
    TASK_CREATED_EVENT_TYPE,
    taskCreatedIdempotencyKey,
    type ProjectedTaskCreatedPayload,
} from './task-projection-store';
export {
    ProjectProjectionStore,
    PROJECT_PROJECTION_SUBSCRIBER,
    PROJECT_PROJECTION_EVENT_TYPES,
} from './project-projection-store';
export {
    PlanProjectionStore,
    PLAN_PROJECTION_SUBSCRIBER,
    PLAN_PROJECTION_EVENT_TYPES,
} from './plan-projection-store';
export {
    AgentProjectionStore,
    AGENT_PROJECTION_SUBSCRIBER,
    AGENT_PROJECTION_EVENT_TYPES,
    type AgentListRow,
} from './agent-projection-store';
