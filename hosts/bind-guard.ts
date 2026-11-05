/**
 * Shared guard: binding an UNAUTHENTICATED host to a non-loopback
 * address has to be a deliberate act, not a config copy-paste.
 *
 * `board-ui` and `manager-board` serve static files and proxy to the
 * worker-api / manager-api with the operator's token INJECTED on every
 * forwarded request. They have no auth of their own, and no token can
 * give them any: the browser never holds the credential, the process
 * does (a confused deputy). So whoever can reach the port can drive the
 * pipeline — and board commands spawn agents that run with
 * `--dangerously-skip-permissions`, i.e. an unrestricted shell with the
 * operator's credentials. `manager-board` is worse in consequence: the
 * manager-api is the only process allowed to WRITE config.
 *
 * Both servers already warn on a non-loopback bind, and the defaults are
 * loopback. The warning is the part that does not hold up: these run as
 * Windows services, where nobody is watching stdout. A warning nobody
 * reads is indistinguishable from no warning.
 *
 * So the entry points REFUSE unless the operator sets the matching
 * `*_ALLOW_REMOTE` flag. The flag is not a credential and is not
 * pretending to be one — it exists so that exposing an unauthenticated
 * control plane cannot happen by accident, and so the person who does it
 * has read a sentence explaining what they are taking on.
 *
 * Enforced in the `main()` entry points rather than inside `start()`:
 * that is where an operator's `.env` lands, and it leaves programmatic
 * callers (tests, embedders) free to bind what they ask for.
 */

/**
 * Addresses that cannot be reached from another machine.
 *
 * Only the exact spellings the hosts already treat as loopback. A
 * generous matcher here would be the wrong kind of clever: the cost of
 * mistakenly calling an address loopback is an unauthenticated control
 * plane on a network, and the cost of being too strict is one env flag.
 */
export const LOOPBACK_HOSTS: readonly string[] = [
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
];

export function isLoopbackHost(host: string): boolean {
    return LOOPBACK_HOSTS.includes(host.trim().toLowerCase());
}

/** Truthy spellings for the opt-in flag. `''`/unset means "no". */
export function isFlagEnabled(raw: string | undefined): boolean {
    const v = (raw ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface RemoteBindDecision {
    /** False means the caller must refuse to start. */
    readonly allowed: boolean;
    /**
     * What to print. Present on a refusal, and also on an allowed
     * remote bind — taking the risk knowingly is not a reason to go
     * quiet about it.
     */
    readonly message: string;
}

export function decideRemoteBind(input: {
    /** Service name for the message, e.g. `board-ui`. */
    readonly service: string;
    readonly host: string;
    /** Name of the opt-in env var, e.g. `BOARD_UI_ALLOW_REMOTE`. */
    readonly allowFlagName: string;
    /** That var's raw value. */
    readonly allowFlagValue: string | undefined;
    /** One clause naming what reaching this port grants. */
    readonly exposes: string;
}): RemoteBindDecision {
    if (isLoopbackHost(input.host)) {
        return { allowed: true, message: '' };
    }
    if (isFlagEnabled(input.allowFlagValue)) {
        return {
            allowed: true,
            message:
                `${input.service}: bound to "${input.host}" with `
                + `${input.allowFlagName} set. This server is UNAUTHENTICATED and `
                + `${input.exposes} Keep it on a private network (Tailscale/VPN) or `
                + 'behind an authenticating reverse proxy.',
        };
    }
    return {
        allowed: false,
        message:
            `${input.service}: REFUSING to bind "${input.host}".\n`
            + `  This server has no authentication of its own, and ${input.exposes}\n`
            + '  Anyone who can reach this port could drive the pipeline, and agents\n'
            + '  run with --dangerously-skip-permissions (an unrestricted shell with\n'
            + '  your credentials).\n'
            + '  If that is what you intend — on a Tailscale/VPN network, or behind an\n'
            + `  authenticating reverse proxy — set ${input.allowFlagName}=1.\n`
            + '  Otherwise leave the host at 127.0.0.1 and reach it over an SSH tunnel.',
    };
}
