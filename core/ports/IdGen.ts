/**
 * Port: identifier generator. Injected so tests can produce deterministic
 * ids and production can use UUIDs / ULIDs / KSUIDs without the core
 * caring which.
 */
export interface IdGen {
  newId(): string;
}
