/**
 * P-SM-003 — unit tests for the `getProjects` / `getAgents` read
 * handlers.
 *
 * Trait category: Unit. Each test drives the pure handler against an
 * in-memory fake read port — no sqlite handle, no filesystem, no HTTP.
 * The handlers own only the wire envelope (`{ projects: [...] }` /
 * `{ agents: [...] }`); the ports own the query, so the fakes return
 * whatever shape the documented body should echo and we assert the
 * handler passes it through verbatim.
 *
 * Tests follow Arrange / Act / Assert: build the fake port (Arrange),
 * call the handler (Act), assert the status + body shape (Assert).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { AgentListRow } from '../../adapters/projections/agent-projection-store';
import {
    getAgents,
    getProjects,
    type AgentsReadPort,
    type ProjectReadRow,
    type ProjectsReadPort,
} from './routes';

function fakeProjectsPort(rows: readonly ProjectReadRow[]): ProjectsReadPort {
    return {
        listActiveProjects: () => rows,
    };
}

function fakeAgentsPort(rows: readonly AgentListRow[]): AgentsReadPort {
    return {
        list: () => rows,
    };
}

// ---------------------------------------------------------------------------
// getProjects
// ---------------------------------------------------------------------------

test('getProjects: empty port returns 200 with { projects: [] }', () => {
    const result = getProjects({ projects: fakeProjectsPort([]) });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { projects: [] });
});

test('getProjects: populated port returns the rows verbatim', () => {
    const rows: ProjectReadRow[] = [
        { id: 'p-1', name: 'Alpha', metadata: { abbr: 'AL', color: '#123' } },
        { id: 'p-2', name: null, metadata: null },
    ];

    const result = getProjects({ projects: fakeProjectsPort(rows) });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { projects: rows });
});

// ---------------------------------------------------------------------------
// getAgents
// ---------------------------------------------------------------------------

test('getAgents: empty port returns 200 with { agents: [] }', () => {
    const result = getAgents({ agents: fakeAgentsPort([]) });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { agents: [] });
});

test('getAgents: populated port returns the rows verbatim', () => {
    const rows: AgentListRow[] = [
        {
            agentId: 'a-1',
            name: 'Reviewer',
            role: 'reviewer',
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
            prompt: 'Review carefully.',
            updatedAt: 1000,
        },
        {
            agentId: 'a-2',
            name: null,
            role: null,
            provider: null,
            model: null,
            prompt: null,
            updatedAt: null,
        },
    ];

    const result = getAgents({ agents: fakeAgentsPort(rows) });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { agents: rows });
});
