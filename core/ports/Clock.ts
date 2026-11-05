/**
 * Port: source of "now". Injected so deterministic tests can swap in a
 * fixed/fake clock without monkey-patching `Date`.
 */
export interface Clock {
  now(): Date;
}
