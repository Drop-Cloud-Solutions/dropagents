/**
 * Barrel for SQLite-backed projections that fold the event log into a
 * read model under `core/state/`. Hosts wiring the worker-api state
 * layer import from this module so the set of registered projections is
 * discoverable in one place.
 */

export {
    ParkedTasksProjection,
    PARKED_TASKS_PROJECTION_SUBSCRIBER,
    getParkedTaskCount,
} from './parked-tasks-projection';
