/* eslint-env browser */
/*
 * Pipeline manager-board — vanilla-JS SPA.
 *
 * Talks ONLY to the same-origin /api/* proxy that the manager-board
 * server fronts the manager-api with. The proxy injects the bearer
 * token on every upstream request, so the browser never sees it.
 *
 * Routes used:
 *   - GET    /api/flows                    — sidebar list
 *   - GET    /api/pipeline                 — current pipeline.yaml
 *   - GET    /api/flows/:name              — current flow YAML
 *   - PUT    /api/pipeline                 — atomic write of pipeline.yaml
 *                                            (`?dry_run=1` = validate only)
 *   - PUT    /api/flows/:name              — atomic write of one flow YAML
 *                                            (`?dry_run=1` = validate only)
 *   - POST   /api/reload                   — "Apply": hot-reload flows into
 *                                            the running orchestrator
 *   - GET    /api/settings                 — curated runtime settings
 *                                            (secret values never echoed)
 *   - PUT    /api/settings/:key            — store a setting (on restart)
 *   - DELETE /api/settings/:key            — drop an override (back to .env)
 *   - GET    /api/projects                 — project list
 *   - POST   /api/projects                 — create project
 *   - PUT    /api/projects/:projectId      — edit project
 *   - DELETE /api/projects/:projectId      — archive project (v1 never hard-deleted)
 *   - GET    /api/agents                   — agent list
 *   - POST   /api/agents                   — create agent
 *   - PUT    /api/agents/:agentId          — edit agent
 *   - DELETE /api/agents/:agentId          — delete agent
 *   - GET    /api/agent-providers          — registered LLM providers
 *   - GET    /api/agent-roles              — role vocabulary + fallback config
 *   - GET    /api/agent-md/:role           — agents/<role>.CLAUDE.md content
 *   - PUT    /api/agent-md/:role           — write the persona MD file
 *   - POST   /api/agent-md/:role/generate  — author a draft from a purpose text
 *   - GET    /api/step-kinds               — step/role enum
 *   - GET    /api/agent-models/:role       — legacy per-role override + default
 *   - PUT    /api/agent-models/:role       — legacy override write
 *
 * Option B (Phase 3): the Agents panel is the control center — one row
 * per pipeline role showing the effective model/provider/persona the
 * orchestrator resolves on the next spawn (it reads the agents table
 * live). The standalone "Model overrides" panel is folded in: Agent.model
 * IS the live model override. The agent-models endpoints stay in the API
 * client for parity, but no panel drives them any more — the ConfigStore
 * rows they write are not consumed by the orchestrator.
 *
 * The makeApi() factory wraps every call so the test suite can inject
 * a stub fetch. The browser bootstrap path consumes the same factory.
 *
 * GET responses for the YAML editor are JSON; the editor needs YAML, so
 * the JSON is re-serialised through a small dumper below. Comments and
 * original key ordering are not preserved through the round-trip — by
 * design, the manager-api is the source of truth and the editor is a
 * thin structural view.
 */

(function () {
    'use strict';

    // -----------------------------------------------------------------
    // API factory — pure, no DOM, testable in isolation.
    // -----------------------------------------------------------------

    function makeApi(opts) {
        const fetchFn =
            opts && typeof opts.fetch === 'function'
                ? opts.fetch
                : function () {
                      return globalThis.fetch.apply(globalThis, arguments);
                  };

        function jsonHeaders() {
            return { 'Content-Type': 'application/json' };
        }
        function yamlHeaders() {
            return { 'Content-Type': 'text/yaml' };
        }

        async function parseJsonSafe(res) {
            try {
                return await res.json();
            } catch (_err) {
                return null;
            }
        }

        async function getJson(url) {
            const res = await fetchFn(url, { method: 'GET' });
            const body = await parseJsonSafe(res);
            return { ok: res.ok, status: res.status, body: body };
        }

        async function sendJson(method, url, payload) {
            const res = await fetchFn(url, {
                method: method,
                headers: jsonHeaders(),
                body: JSON.stringify(payload || {})
            });
            const body = await parseJsonSafe(res);
            return { ok: res.ok, status: res.status, body: body };
        }

        async function sendNoBody(method, url) {
            const res = await fetchFn(url, { method: method });
            const body = await parseJsonSafe(res);
            return { ok: res.ok, status: res.status, body: body };
        }

        async function sendYaml(url, body, dryRun) {
            // `?dry_run=1` = Phase 4 "real Validate": the manager-api runs
            // the full loader validation and stops before the write.
            const target = dryRun ? url + '?dry_run=1' : url;
            const res = await fetchFn(target, {
                method: 'PUT',
                headers: yamlHeaders(),
                body: body
            });
            const out = await parseJsonSafe(res);
            return { ok: res.ok, status: res.status, body: out };
        }

        return {
            // Flow editor (AP-IFW-002).
            listFlows: function () {
                return getJson('/api/flows');
            },
            getPipeline: function () {
                return getJson('/api/pipeline');
            },
            getFlow: function (name) {
                return getJson('/api/flows/' + encodeURIComponent(name));
            },
            putPipelineYaml: function (yaml, dryRun) {
                return sendYaml('/api/pipeline', yaml, !!dryRun);
            },
            putFlowYaml: function (name, yaml, dryRun) {
                return sendYaml('/api/flows/' + encodeURIComponent(name), yaml, !!dryRun);
            },
            // Flow assistant: one turn against the editor's CURRENT text.
            // Returns a revised YAML for the editor; writes nothing.
            flowChat: function (name, yaml, question) {
                return sendJson('POST', '/api/flows/' + encodeURIComponent(name) + '/chat', {
                    yaml: yaml,
                    question: question
                });
            },
            // Operator "Apply" (Phase 4): hot-reload config/flows into the
            // running orchestrator via manager-api POST /reload.
            applyConfig: function () {
                return sendNoBody('POST', '/api/reload');
            },

            // Operator profile: where config is saved, what is customised,
            // and the way back to each built-in default.
            getProfile: function () {
                return getJson('/api/profile');
            },
            acknowledgeDefault: function (relPath) {
                return sendJson('POST', '/api/profile/acknowledge', { path: relPath });
            },
            resetPipeline: function () {
                return sendNoBody('DELETE', '/api/pipeline');
            },
            resetFlow: function (name) {
                return sendNoBody('DELETE', '/api/flows/' + encodeURIComponent(name));
            },
            resetAgentMd: function (role) {
                return sendNoBody('DELETE', '/api/agent-md/' + encodeURIComponent(role));
            },
            getPipelineDefault: function () {
                return getJson('/api/pipeline?layer=default');
            },
            listGithubAccounts: function () {
                return getJson('/api/github-accounts');
            },
            putGithubAccounts: function (accounts) {
                return sendJson('PUT', '/api/github-accounts', { accounts: accounts });
            },
            testGithubAccount: function (id) {
                return sendJson(
                    'POST',
                    '/api/github-accounts/' + encodeURIComponent(id) + '/test',
                    {}
                );
            },
            getFlowDefault: function (name) {
                return getJson('/api/flows/' + encodeURIComponent(name) + '?layer=default');
            },
            getAgentMdDefault: function (role) {
                return getJson('/api/agent-md/' + encodeURIComponent(role) + '?layer=default');
            },

            // Settings (Phase 5): curated runtime settings, secrets write-only.
            listSettings: function () {
                return getJson('/api/settings');
            },
            putSetting: function (key, value, etag) {
                const payload = etag ? { value: value, etag: etag } : { value: value };
                return sendJson('PUT', '/api/settings/' + encodeURIComponent(key), payload);
            },
            deleteSetting: function (key) {
                return sendNoBody('DELETE', '/api/settings/' + encodeURIComponent(key));
            },

            // Projects (AP-IFG-018).
            listProjects: function () {
                return getJson('/api/projects');
            },
            createProject: function (payload) {
                return sendJson('POST', '/api/projects', payload);
            },
            updateProject: function (projectId, payload) {
                return sendJson('PUT', '/api/projects/' + encodeURIComponent(projectId), payload);
            },
            archiveProject: function (projectId) {
                return sendNoBody('DELETE', '/api/projects/' + encodeURIComponent(projectId));
            },

            // Agents (AP-IFG-018).
            listAgents: function () {
                return getJson('/api/agents');
            },
            createAgent: function (payload) {
                return sendJson('POST', '/api/agents', payload);
            },
            updateAgent: function (agentId, payload) {
                return sendJson('PUT', '/api/agents/' + encodeURIComponent(agentId), payload);
            },
            deleteAgent: function (agentId) {
                return sendNoBody('DELETE', '/api/agents/' + encodeURIComponent(agentId));
            },

            // Static enums + per-role model overrides (AP-IFG-017 + AP-IFG-018).
            getAgentProviders: function () {
                return getJson('/api/agent-providers');
            },
            getAgentRoles: function () {
                return getJson('/api/agent-roles');
            },
            getStepKinds: function () {
                return getJson('/api/step-kinds');
            },
            getAgentModel: function (role) {
                return getJson('/api/agent-models/' + encodeURIComponent(role));
            },
            setAgentModel: function (role, model, etag) {
                const payload = etag ? { model: model, etag: etag } : { model: model };
                return sendJson('PUT', '/api/agent-models/' + encodeURIComponent(role), payload);
            },

            // Persona MD files (agents/<role>.CLAUDE.md).
            getAgentMd: function (role) {
                return getJson('/api/agent-md/' + encodeURIComponent(role));
            },
            putAgentMd: function (role, content) {
                return sendJson('PUT', '/api/agent-md/' + encodeURIComponent(role), {
                    content: content
                });
            },
            generateAgentMd: function (role, purpose) {
                return sendJson(
                    'POST',
                    '/api/agent-md/' + encodeURIComponent(role) + '/generate',
                    { purpose: purpose }
                );
            },
            regenerateAgentMd: function (role, instructions) {
                return sendJson(
                    'POST',
                    '/api/agent-md/' + encodeURIComponent(role) + '/generate',
                    { instructions: instructions }
                );
            },

            // Project architecture context (ConfigStore ProjectConfig,
            // metadata.context_md). Reaches the planner / decomposer /
            // architect as the `# Project context` prompt block.
            getProjectContextMd: function (projectId) {
                return getJson(
                    '/api/projects/' + encodeURIComponent(projectId) + '/context-md'
                );
            },
            // `etag` round-trips from the GET so a save that lost a race
            // comes back 409 instead of overwriting the other edit.
            putProjectContextMd: function (projectId, content, etag) {
                const payload = etag
                    ? { content: content, etag: etag }
                    : { content: content };
                return sendJson(
                    'PUT',
                    '/api/projects/' + encodeURIComponent(projectId) + '/context-md',
                    payload
                );
            }
        };
    }

    // -----------------------------------------------------------------
    // Browser bootstrap. Skipped under Node tests where there is no
    // `document`.
    // -----------------------------------------------------------------

    function bootstrapUi(api) {
        const fileListEl = document.getElementById('file-list');
        const statusDot = document.getElementById('status-dot');
        const statusLabel = document.getElementById('status-label');

        // YAML editor refs.
        const editorEl = document.getElementById('editor');
        const titleEl = document.getElementById('editor-title');
        const messageEl = document.getElementById('message');
        const validateBtn = document.getElementById('validate-btn');
        const saveBtn = document.getElementById('save-btn');
        const applyBtn = document.getElementById('apply-btn');
        const flowChatBtn = document.getElementById('flow-chat-btn');
        const flowChatBackdrop = document.getElementById('flow-chat-backdrop');
        const flowChatThread = document.getElementById('flow-chat-thread');
        const flowChatForm = document.getElementById('flow-chat-form');
        const flowChatInput = document.getElementById('flow-chat-input');
        const flowChatSend = document.getElementById('flow-chat-send');
        const flowChatClose = document.getElementById('flow-chat-close');

        // Profile refs.
        const profileLabel = document.getElementById('profile-label');
        const yamlProfileBar = document.getElementById('yaml-profile-bar');
        const yamlProfileState = document.getElementById('yaml-profile-state');
        const yamlShowDefaultBtn = document.getElementById('yaml-show-default-btn');
        const yamlAckBtn = document.getElementById('yaml-ack-btn');
        const yamlResetBtn = document.getElementById('yaml-reset-btn');

        // Last GET /profile body: { active, home, initialised, pipeline, flows, agents }.
        let profileState = { active: false, home: null, initialised: false };
        // "Show default" on the YAML editor: the operator's text is parked
        // here while the read-only default is on screen.
        let yamlShowingDefault = false;
        let yamlMineContent = '';

        // Editors panel refs.
        const panels = {
            yaml: document.getElementById('panel-yaml'),
            projects: document.getElementById('panel-projects'),
            agents: document.getElementById('panel-agents'),
            settings: document.getElementById('panel-settings'),
            githubAccounts: document.getElementById('panel-github-accounts'),
            empty: document.getElementById('panel-empty')
        };

        let selection = null;
        let busy = false;

        // --- panel switching ----------------------------------------

        function showPanel(name) {
            for (const k of Object.keys(panels)) {
                if (panels[k]) panels[k].hidden = k !== name;
            }
        }

        // --- sidebar ------------------------------------------------

        async function bootstrap() {
            try {
                const res = await api.listFlows();
                if (!res.ok) {
                    setStatus('error', 'manager-api unreachable (HTTP ' + res.status + ')');
                    renderSidebar([]);
                    return;
                }
                const flows = res.body && Array.isArray(res.body.flows) ? res.body.flows : [];
                renderSidebar(flows);
                setStatus('ready', 'connected');
            } catch (err) {
                setStatus('error', 'manager-api unreachable');
                // eslint-disable-next-line no-console
                console.error('manager-board: bootstrap failed', err);
                renderSidebar([]);
            }
        }

        function renderSidebar(flows) {
            fileListEl.replaceChildren();
            appendSection('pipeline');
            appendItem({ kind: 'pipeline', label: 'pipeline.yaml' });
            appendSection('flows');
            for (const name of flows.slice().sort()) {
                appendItem({ kind: 'flow', name: name, label: name + '.yaml' });
            }
            // The file name IS the task type, so creating a flow is really
            // naming a task type. The entry sits with the flows it creates
            // rather than in a toolbar, so the naming rule is visible next
            // to the existing names.
            appendItem({ kind: 'newflow', label: '+ New flow…', className: 'new-item' });
            appendSection('configuration');
            appendItem({ kind: 'projects', label: 'Projects' });
            appendItem({ kind: 'agents', label: 'Agents' });
            appendItem({ kind: 'settings', label: 'Settings' });
            appendItem({ kind: 'github-accounts', label: 'GitHub accounts' });
        }

        function appendSection(label) {
            const li = document.createElement('li');
            li.className = 'section';
            li.textContent = label;
            fileListEl.appendChild(li);
        }

        function appendItem(item) {
            const li = document.createElement('li');
            li.textContent = item.label;
            if (item.className) li.className = item.className;
            li.addEventListener('click', function () {
                select(item, li);
            });
            fileListEl.appendChild(li);
        }

        // --- selection ----------------------------------------------

        async function select(item, li) {
            if (busy) return;
            for (const el of fileListEl.querySelectorAll('li.selected')) {
                el.classList.remove('selected');
            }
            li.classList.add('selected');
            selection = item;
            if (item.kind === 'newflow') {
                await startNewFlow(li);
                return;
            }
            if (item.kind === 'pipeline' || item.kind === 'flow') {
                await openYamlEditor(item);
            } else if (item.kind === 'projects') {
                showPanel('projects');
                await renderProjects();
            } else if (item.kind === 'agents') {
                showPanel('agents');
                await renderAgents();
            } else if (item.kind === 'settings') {
                showPanel('settings');
                await renderSettings();
            } else if (item.kind === 'github-accounts') {
                showPanel('githubAccounts');
                await renderGithubAccounts();
            }
            updateFlowChatAvailability();
        }

        // --- YAML editor (preserved from AP-IFW-002) -----------------

        async function openYamlEditor(item) {
            showPanel('yaml');
            titleEl.textContent = labelFor(item);
            clearMessage(messageEl);
            editorEl.value = '';
            editorEl.disabled = true;
            validateBtn.disabled = true;
            saveBtn.disabled = true;
            applyBtn.disabled = true;

            try {
                const res =
                    item.kind === 'pipeline' ? await api.getPipeline() : await api.getFlow(item.name);
                if (!res.ok) {
                    showError(
                        messageEl,
                        'Failed to load ' + labelFor(item) + ' (HTTP ' + res.status + ')'
                    );
                    return;
                }
                const loaded = editorTextFor(item.kind, res.body);
                editorEl.value = loaded.text;
                editorEl.disabled = false;
                validateBtn.disabled = false;
                saveBtn.disabled = false;
                applyBtn.disabled = false;
                yamlShowingDefault = false;
                await refreshProfile();
                updateYamlProfileBar();
                if (loaded.error) {
                    // Opened, editable, and told why it is broken. This
                    // file used to answer 500 and could not be opened at
                    // all — in the editor that exists to fix it.
                    showError(
                        messageEl,
                        'This file does not currently load: ' + loaded.error
                    );
                }
                editorEl.focus();
            } catch (err) {
                showError(
                    messageEl,
                    'Failed to load ' + labelFor(item) + ': ' + (err && err.message)
                );
            }
        }

        // --- flow assistant ------------------------------------------
        //
        // A chat thread bound to the file in the editor. Each turn sends the
        // editor's CURRENT text, so hand edits made between turns are what
        // the agent reasons about - not what it last proposed. A reply that
        // carries YAML replaces the editor contents and nothing else: no
        // write happens until the operator clicks Save, which runs the same
        // loader validation every manual edit goes through.

        let flowChatBusy = false;

        // Only flows. pipeline.yaml is a different schema with different
        // failure modes, and the flow-author persona would confidently
        // rewrite it into something the loader rejects.
        function updateFlowChatAvailability() {
            // Called from every selection change, so it must survive the
            // button being absent — see the wiring guard below.
            if (!flowChatBtn) return;
            const isFlow = !!selection && selection.kind === 'flow';
            flowChatBtn.disabled = !isFlow;
            flowChatBtn.title = isFlow
                ? 'Ask the flow assistant to rewrite this file'
                : 'The assistant edits flows only';
        }

        function openFlowChat() {
            if (!flowChatReady) return;
            if (!selection || selection.kind !== 'flow') return;
            flowChatBackdrop.hidden = false;
            document.getElementById('flow-chat-title').textContent =
                'Flow assistant - ' + selection.name + '.yaml';
            flowChatInput.focus();
        }

        function closeFlowChat() {
            flowChatBackdrop.hidden = true;
        }

        function appendChatBubble(role, text) {
            const el = document.createElement('div');
            el.className = 'chat-msg chat-msg--' + role;
            el.textContent = text;
            flowChatThread.appendChild(el);
            flowChatThread.scrollTop = flowChatThread.scrollHeight;
            return el;
        }

        async function sendFlowChat() {
            if (flowChatBusy || !selection || selection.kind !== 'flow') return;
            const question = flowChatInput.value.trim();
            if (question.length === 0) return;
            flowChatBusy = true;
            flowChatSend.disabled = true;
            flowChatSend.textContent = 'Working...';
            flowChatInput.value = '';
            appendChatBubble('user', question);
            // An agent turn takes a while and shows nothing until it lands;
            // without this the dialog looks frozen.
            const pending = appendChatBubble('assistant', 'Thinking...');

            let res;
            try {
                res = await api.flowChat(selection.name, editorEl.value, question);
            } catch (err) {
                pending.textContent = 'Network error: ' + (err && err.message);
                flowChatBusy = false;
                flowChatSend.disabled = false;
                flowChatSend.textContent = 'Send';
                return;
            }

            const body = res.body || {};
            if (!res.ok) {
                pending.textContent =
                    (body.error || 'The assistant failed (HTTP ' + res.status + ')')
                    + (body.message ? ': ' + body.message : '');
            } else {
                pending.textContent = body.reply || '(no reply)';
                // Warnings are shown, never swallowed: a dropped proposal
                // block leaves the editor unchanged, which otherwise reads
                // as the assistant ignoring the request.
                if (Array.isArray(body.warnings)) {
                    for (const w of body.warnings) appendChatBubble('system', w);
                }
                if (typeof body.yaml === 'string' && body.yaml.length > 0) {
                    editorEl.value = body.yaml;
                    appendChatBubble(
                        'system',
                        'The editor has been updated. Review it, then close this and click Save.'
                    );
                    showInfo(messageEl, 'Editor updated by the assistant - not saved yet.');
                }
            }
            flowChatBusy = false;
            flowChatSend.disabled = false;
            flowChatSend.textContent = 'Send';
            flowChatThread.scrollTop = flowChatThread.scrollHeight;
        }

        // Wiring guard. Every listener below is attached at load, so a
        // single missing element takes the WHOLE manager script down with a
        // TypeError and the operator sees an empty page - which is exactly
        // what happened when this modal's markup was first placed after the
        // <script> tag. A feature that cannot wire itself must disable
        // itself, not the application.
        const flowChatEls = [
            flowChatBtn,
            flowChatBackdrop,
            flowChatThread,
            flowChatForm,
            flowChatInput,
            flowChatSend,
            flowChatClose
        ];
        const flowChatReady = flowChatEls.every(function (el) {
            return el !== null && el !== undefined;
        });
        if (!flowChatReady) {
            // Visible, not silent: the button is the only clue the feature
            // exists, so say why it is dead rather than leaving a control
            // that does nothing when clicked.
            // eslint-disable-next-line no-console
            console.error('manager-board: flow assistant markup missing - the Chat button is disabled');
            if (flowChatBtn) {
                flowChatBtn.disabled = true;
                flowChatBtn.title = 'Flow assistant unavailable (markup missing)';
            }
        }

        if (flowChatReady) {
            flowChatBtn.addEventListener('click', openFlowChat);
            flowChatClose.addEventListener('click', closeFlowChat);
            flowChatBackdrop.addEventListener('click', function (e) {
                if (e.target === flowChatBackdrop) closeFlowChat();
            });
            flowChatForm.addEventListener('submit', function (e) {
                e.preventDefault();
                void sendFlowChat();
            });
            flowChatInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendFlowChat();
                }
            });
        }

        // --- new flow ------------------------------------------------

        // A flow's FILE NAME is the task type the decomposer emits, so the
        // name is not cosmetic: `implement.yaml` is what makes a task of
        // type `implement` startable. Same character class the manager-api
        // routes on, checked here so a bad name is refused before a
        // round-trip rather than coming back as a 400.
        const FLOW_NAME_RE = /^[A-Za-z0-9_-]+$/;

        // Starter file. Deliberately a COMPLETE, valid, single-step flow
        // rather than an empty buffer: the operator can Save it as-is and
        // get something that runs, and the assistant has real structure to
        // edit instead of inventing a shape from nothing.
        function starterFlowYaml(name) {
            return [
                '# Task type: ' + name,
                '#',
                '# The file name IS the task type: a task of type `' + name + '`',
                '# runs THIS flow. Every task type the decomposer can emit needs a',
                '# flow file, or its tasks are created and never start.',
                'on: TaskApproved',
                'when: task.type == "' + name + '"',
                'start_mode: auto',
                'steps:',
                '  - id: develop',
                '    agent: developer',
                '    model: none',
                '    approval: required',
                '    on_success: emit:TaskFinished',
                '    on_failure: emit:TaskFailed',
                ''
            ].join('\n');
        }

        async function startNewFlow(li) {
            const raw = window.prompt(
                'New flow name.\n\n'
                    + 'This IS the task type it runs (implement, refactor, document, ...).\n'
                    + 'Letters, digits, dash and underscore only.'
            );
            if (raw === null) return;
            const name = raw.trim();
            if (name.length === 0) return;
            showPanel('yaml');
            if (!FLOW_NAME_RE.test(name)) {
                showError(
                    messageEl,
                    'Invalid flow name "' + name + '" - letters, digits, dash and underscore only.'
                );
                return;
            }

            // Refuse to shadow an existing flow. Opening it as "new" would
            // show the starter template over a real file, and Save would
            // overwrite it without the operator seeing what was there.
            const existing = await api.getFlow(name);
            if (existing.ok) {
                showError(
                    messageEl,
                    'A flow named "' + name + '" already exists - pick it from the list to edit it.'
                );
                return;
            }

            for (const el of fileListEl.querySelectorAll('li.selected')) {
                el.classList.remove('selected');
            }
            if (li) li.classList.add('selected');
            selection = { kind: 'flow', name: name, isNew: true };
            titleEl.textContent = 'flows/' + name + '.yaml (new - not saved yet)';
            clearMessage(messageEl);
            editorEl.value = starterFlowYaml(name);
            editorEl.disabled = false;
            validateBtn.disabled = false;
            saveBtn.disabled = false;
            applyBtn.disabled = false;
            updateFlowChatAvailability();
            showInfo(messageEl, 'Not saved yet - edit or use Chat, then click Save to create the file.');
            editorEl.focus();
        }

        function labelFor(item) {
            return item.kind === 'pipeline' ? 'pipeline.yaml' : 'flows/' + item.name + '.yaml';
        }

        async function submitYaml(intent) {
            if (!selection || busy) return;
            busy = true;
            validateBtn.disabled = true;
            saveBtn.disabled = true;
            applyBtn.disabled = true;
            clearMessage(messageEl);

            // Validate = the SAME server-side validation as Save, sent as a
            // dry run — the loader pass runs in full but nothing is written.
            const dryRun = intent !== 'save';
            const yaml = editorEl.value;
            let res;
            try {
                res =
                    selection.kind === 'pipeline'
                        ? await api.putPipelineYaml(yaml, dryRun)
                        : await api.putFlowYaml(selection.name, yaml, dryRun);
            } catch (err) {
                showError(messageEl, 'Network error: ' + (err && err.message));
                busy = false;
                validateBtn.disabled = false;
                saveBtn.disabled = false;
                applyBtn.disabled = false;
                return;
            }

            if (res.ok) {
                if (intent === 'save') {
                    showInfo(messageEl, 'Saved — use "Apply to orchestrator" to hot-reload flows');
                    // Refresh from disk — the exact bytes just written,
                    // comments and all, rather than a parse-then-dump
                    // that would strip them back out.
                    const refresh =
                        selection.kind === 'pipeline'
                            ? await api.getPipeline()
                            : await api.getFlow(selection.name);
                    if (refresh.ok) {
                        editorEl.value = editorTextFor(selection.kind, refresh.body).text;
                    }
                    await refreshProfile();
                    updateYamlProfileBar();
                    // A brand-new flow now exists on disk: drop the
                    // not-saved-yet framing and put it in the sidebar, or
                    // the operator has no way back to it after clicking
                    // elsewhere.
                    if (selection.isNew) {
                        selection = { kind: 'flow', name: selection.name };
                        titleEl.textContent = labelFor(selection);
                        const listed = await api.listFlows();
                        if (listed.ok && listed.body && Array.isArray(listed.body.flows)) {
                            renderSidebar(listed.body.flows);
                        }
                    }
                } else {
                    showInfo(messageEl, 'Valid (dry run — nothing saved)');
                }
            } else {
                const err = extractError(res.body);
                if (res.status === 422) showError(messageEl, err || 'Validation failed');
                else if (res.status === 400) showError(messageEl, err || 'Validation failed');
                else if (res.status === 415) showError(messageEl, err || 'Unsupported content type');
                else if (res.status === 409)
                    showError(messageEl, err || 'Another write is in progress; retry shortly');
                else if (res.status === 401 || res.status === 403)
                    showError(messageEl, 'Not authorised — check the manager-board proxy token');
                else showError(messageEl, 'HTTP ' + res.status + (err ? ': ' + err : ''));
            }

            busy = false;
            validateBtn.disabled = false;
            saveBtn.disabled = false;
            applyBtn.disabled = false;
        }

        // Operator "Apply": hot-reload config/flows into the running
        // orchestrator. Flows only — the response's `note` (surfaced
        // verbatim) reminds that pipeline.yaml/.env need a restart.
        async function applyConfig() {
            if (busy) return;
            busy = true;
            validateBtn.disabled = true;
            saveBtn.disabled = true;
            applyBtn.disabled = true;
            clearMessage(messageEl);

            let res;
            try {
                res = await api.applyConfig();
            } catch (err) {
                showError(messageEl, 'Network error: ' + (err && err.message));
                busy = false;
                validateBtn.disabled = false;
                saveBtn.disabled = false;
                applyBtn.disabled = false;
                return;
            }

            if (res.ok) {
                const body = res.body || {};
                const count = typeof body.flows === 'number' ? body.flows : '?';
                showInfo(
                    messageEl,
                    'Applied — ' + count + ' flows reloaded.'
                        + (body.note ? ' ' + body.note + '.' : '')
                );
            } else {
                const err = extractError(res.body);
                if (res.status === 502)
                    showError(messageEl, err || 'Orchestrator unreachable — is the worker-api running?');
                else if (res.status === 422)
                    showError(messageEl, err || 'Reload rejected — a flow on disk is invalid');
                else showError(messageEl, 'HTTP ' + res.status + (err ? ': ' + err : ''));
            }

            busy = false;
            validateBtn.disabled = false;
            saveBtn.disabled = false;
            applyBtn.disabled = false;
        }

        validateBtn.addEventListener('click', function () {
            submitYaml('validate');
        });
        saveBtn.addEventListener('click', function () {
            submitYaml('save');
        });
        applyBtn.addEventListener('click', applyConfig);

        // --- profile: layer bar on the YAML editor --------------------

        async function refreshProfile() {
            try {
                const res = await api.getProfile();
                if (res.ok && res.body) profileState = res.body;
            } catch (_err) {
                /* keep the last known state; the bar just shows less */
            }
            renderProfileLabel();
            applyAgentPromptMode();
        }

        function renderProfileLabel() {
            if (!profileLabel) return;
            if (!profileState.active) {
                profileLabel.textContent = 'No profile active - edits are saved into the app folder';
                profileLabel.className = 'profile-label profile-label--warn';
                return;
            }
            profileLabel.textContent = 'Profile: ' + profileState.home
                + (profileState.initialised ? '' : ' (not initialised - run npm run profile:init)');
            profileLabel.className = 'profile-label'
                + (profileState.initialised ? '' : ' profile-label--warn');
        }

        function yamlLayerInfo(item) {
            if (!item || !profileState.active) return null;
            if (item.kind === 'pipeline') return profileState.pipeline || null;
            return (profileState.flows && profileState.flows[item.name]) || null;
        }

        function yamlRelPath(item) {
            return item.kind === 'pipeline' ? 'pipeline.yaml' : 'flows/' + item.name + '.yaml';
        }

        // One sentence per state, shared by the YAML and persona editors.
        function describeLayer(info) {
            if (!info) return '';
            if (info.customised && !info.hasDefault) return 'Only in your profile - there is no built-in version.';
            if (info.customised && info.defaultChanged) {
                return 'Customised in your profile. The built-in default has changed since - compare and review.';
            }
            if (info.customised) return 'Customised in your profile.';
            return 'Built-in default. Saving creates your own copy in your profile.';
        }

        function badgeClass(info) {
            if (info && info.defaultChanged) return 'badge badge--warn';
            if (info && info.customised) return 'badge badge--customised';
            return 'badge';
        }

        function configureLayerButtons(info, showingDefault, showBtn, ackBtn, resetBtn) {
            const customised = !!(info && info.customised);
            const hasDefault = !!(info && info.hasDefault);
            showBtn.hidden = !(customised && hasDefault);
            showBtn.textContent = showingDefault ? 'Back to my version' : 'Show default';
            ackBtn.hidden = !(info && info.defaultChanged);
            resetBtn.hidden = !customised;
            resetBtn.textContent = hasDefault ? 'Reset to default' : 'Remove from profile';
        }

        function updateYamlProfileBar() {
            if (!selection || selection.isNew || !profileState.active) {
                yamlProfileBar.hidden = true;
                return;
            }
            const info = yamlLayerInfo(selection);
            yamlProfileBar.hidden = false;
            yamlProfileState.textContent = yamlShowingDefault
                ? 'Showing the built-in default (read-only).'
                : describeLayer(info);
            yamlProfileState.className = badgeClass(info);
            configureLayerButtons(info, yamlShowingDefault, yamlShowDefaultBtn, yamlAckBtn, yamlResetBtn);
        }

        async function toggleYamlDefault() {
            if (!selection || busy) return;
            if (yamlShowingDefault) {
                editorEl.value = yamlMineContent;
                editorEl.disabled = false;
                validateBtn.disabled = false;
                saveBtn.disabled = false;
                yamlShowingDefault = false;
                clearMessage(messageEl);
                updateYamlProfileBar();
                return;
            }
            const res = selection.kind === 'pipeline'
                ? await api.getPipelineDefault()
                : await api.getFlowDefault(selection.name);
            if (!res.ok) {
                showError(messageEl, extractError(res.body) || 'Could not load the default (HTTP ' + res.status + ')');
                return;
            }
            yamlMineContent = editorEl.value;
            editorEl.value = editorTextFor(selection.kind, res.body).text;
            // Read-only while the default is shown: a Save now would write
            // the default INTO the profile and freeze it there.
            editorEl.disabled = true;
            validateBtn.disabled = true;
            saveBtn.disabled = true;
            yamlShowingDefault = true;
            updateYamlProfileBar();
        }

        async function acknowledgeYamlDefault() {
            if (!selection || busy) return;
            const res = await api.acknowledgeDefault(yamlRelPath(selection));
            if (!res.ok) {
                showError(messageEl, extractError(res.body) || 'Could not mark as reviewed (HTTP ' + res.status + ')');
                return;
            }
            await refreshProfile();
            updateYamlProfileBar();
            showInfo(messageEl, 'Marked as reviewed. You will be told again if the default changes.');
        }

        async function resetYaml() {
            if (!selection || busy) return;
            const info = yamlLayerInfo(selection);
            const label = labelFor(selection);
            const prompt = info && !info.hasDefault
                ? 'Remove ' + label + ' from your profile? There is no built-in version, so it will be gone.'
                : 'Reset ' + label + ' to the built-in default? Your copy in the profile is deleted.';
            // eslint-disable-next-line no-alert
            if (!window.confirm(prompt)) return;
            const res = selection.kind === 'pipeline'
                ? await api.resetPipeline()
                : await api.resetFlow(selection.name);
            if (!res.ok) {
                showError(messageEl, extractError(res.body) || 'Reset failed (HTTP ' + res.status + ')');
                return;
            }
            if (selection.kind === 'flow') {
                const listed = await api.listFlows();
                const names = listed.ok && listed.body && Array.isArray(listed.body.flows) ? listed.body.flows : [];
                renderSidebar(names);
                if (names.indexOf(selection.name) < 0) {
                    selection = null;
                    showPanel('empty');
                    return;
                }
            }
            await openYamlEditor(selection);
            showInfo(
                messageEl,
                selection.kind === 'pipeline'
                    ? 'Back on the built-in default. Restart the orchestrator for pipeline.yaml changes.'
                    : 'Back on the built-in default. Use "Apply to orchestrator" to hot-reload flows.'
            );
        }

        yamlShowDefaultBtn.addEventListener('click', toggleYamlDefault);
        yamlAckBtn.addEventListener('click', acknowledgeYamlDefault);
        yamlResetBtn.addEventListener('click', resetYaml);

        // --- Projects editor ----------------------------------------

        const projectListEl = document.getElementById('project-list');
        const projectMsgEl = document.getElementById('project-message');
        const projectForm = document.getElementById('project-form');
        const projectIdInput = document.getElementById('project-id-input');
        const projectNameInput = document.getElementById('project-name-input');
        const projectDescInput = document.getElementById('project-desc-input');
        const projectNewBtn = document.getElementById('project-new-btn');
        const projectRefreshBtn = document.getElementById('project-refresh-btn');
        const projectCancelBtn = document.getElementById('project-cancel-btn');
        const projectContextEditor = document.getElementById('project-context-editor');
        const projectContextTitle = document.getElementById('project-context-title');
        const projectContextArea = document.getElementById('project-context-content');
        const projectContextMsgEl = document.getElementById('project-context-message');
        const projectContextSaveBtn = document.getElementById('project-context-save-btn');
        const projectContextCloseBtn = document.getElementById('project-context-close-btn');

        let editingProjectId = null;
        let editingContextProjectId = null;
        let projectContextEtag = '';

        async function renderProjects() {
            clearMessage(projectMsgEl);
            projectListEl.replaceChildren();
            const res = await api.listProjects();
            if (!res.ok) {
                if (res.status === 404) {
                    appendEmpty(projectListEl, 'No project list endpoint available yet.');
                } else {
                    showError(
                        projectMsgEl,
                        'Failed to load projects (HTTP ' + res.status + ')'
                    );
                }
                return;
            }
            const projects = extractList(res.body, ['projects', 'items']);
            if (projects.length === 0) {
                appendEmpty(projectListEl, 'No projects yet.');
                return;
            }
            for (const p of projects) {
                projectListEl.appendChild(renderProjectRow(p));
            }
        }

        function renderProjectRow(p) {
            // GET /projects returns the projection row, whose id field is
            // `id` — not `projectId`, which is the COMMAND payload's name.
            // Every action here read `p.projectId` and so got undefined:
            // Archive was permanently disabled, Edit opened with a blank
            // id, and the row showed no id at all. Normalise once.
            const projectId = p.projectId || p.id || '';
            const li = document.createElement('li');
            li.className = 'entity-row';
            const meta = document.createElement('div');
            meta.className = 'entity-meta';
            const name = document.createElement('span');
            name.className = 'entity-name';
            name.textContent = p.name || projectId || '(unnamed)';
            const sub = document.createElement('span');
            sub.className = 'entity-sub';
            sub.textContent =
                projectId +
                (p.description ? ' — ' + p.description : '') +
                (p.archived ? ' (archived)' : '');
            meta.appendChild(name);
            meta.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'entity-actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', function () {
                openProjectForm({ ...p, projectId: projectId });
            });
            // Architecture context — the prose description of how this
            // project's repos fit together, handed to the planner,
            // decomposer and architect.
            const contextBtn = document.createElement('button');
            contextBtn.type = 'button';
            contextBtn.textContent = 'Context';
            contextBtn.disabled = !projectId;
            contextBtn.addEventListener('click', function () {
                openProjectContext(projectId, p.name);
            });
            const archiveBtn = document.createElement('button');
            archiveBtn.type = 'button';
            archiveBtn.className = 'danger';
            archiveBtn.textContent = p.archived ? 'Archived' : 'Archive';
            archiveBtn.disabled = !!p.archived || !projectId;
            archiveBtn.addEventListener('click', function () {
                archiveProject(projectId);
            });
            actions.appendChild(editBtn);
            actions.appendChild(contextBtn);
            actions.appendChild(archiveBtn);

            li.appendChild(meta);
            li.appendChild(actions);
            return li;
        }

        // -------------------------------------------------------------
        // Project architecture context editor.
        //
        // Deliberately shows WHO reads the file: an operator writing into
        // a box with no stated consumer has no way to judge what belongs
        // in it. The etag from the GET round-trips through the save so a
        // concurrent edit is a 409 rather than a silent overwrite.
        // -------------------------------------------------------------
        // The editor takes over the panel while it is open. It is a page
        // of prose sharing one scroll container with the project list, so
        // leaving the list up costs the textarea most of its height and
        // pushes the Save button below the fold on a laptop screen.
        // Close puts the list back.
        function setProjectListVisible(visible) {
            projectListEl.hidden = !visible;
            if (!visible) projectForm.hidden = true;
        }

        async function openProjectContext(projectId, projectName) {
            if (!projectId) return;
            clearMessage(projectMsgEl);
            setProjectListVisible(false);
            projectContextEditor.hidden = false;
            projectContextTitle.textContent =
                'Architecture context — ' + (projectName || projectId);
            projectContextArea.value = '';
            projectContextArea.disabled = true;
            projectContextEtag = '';
            editingContextProjectId = projectId;

            const res = await api.getProjectContextMd(projectId);
            if (!res.ok) {
                showError(
                    projectContextMsgEl,
                    'Failed to load context (HTTP ' + res.status + ')'
                );
                return;
            }
            projectContextArea.disabled = false;
            projectContextArea.value = (res.body && res.body.content) || '';
            projectContextEtag = (res.body && res.body.etag) || '';
            projectContextArea.focus();
        }

        function closeProjectContext() {
            projectContextEditor.hidden = true;
            setProjectListVisible(true);
            projectContextArea.value = '';
            projectContextEtag = '';
            editingContextProjectId = null;
            clearMessage(projectContextMsgEl);
        }

        async function saveProjectContext() {
            if (!editingContextProjectId) return;
            clearMessage(projectContextMsgEl);
            const res = await api.putProjectContextMd(
                editingContextProjectId,
                projectContextArea.value,
                projectContextEtag
            );
            if (!res.ok) {
                // 422 carries the integrity guard's reason (truncated
                // content); 409 means someone else saved first. Both are
                // worth showing verbatim — they tell the operator what to
                // do next.
                showError(
                    projectContextMsgEl,
                    extractError(res.body) || 'Save failed (HTTP ' + res.status + ')'
                );
                return;
            }
            projectContextEtag = (res.body && res.body.etag) || '';
            showInfo(
                projectContextMsgEl,
                'Saved. Click Apply (or restart the worker) to hand it to the next '
                    + 'planner / decomposer / architect run.'
            );
        }

        function openProjectForm(existing) {
            projectForm.hidden = false;
            editingProjectId = existing ? existing.projectId || null : null;
            projectIdInput.value = existing ? existing.projectId || '' : '';
            projectIdInput.disabled = !!editingProjectId;
            projectNameInput.value = existing ? existing.name || '' : '';
            projectDescInput.value = existing ? existing.description || '' : '';
            projectNameInput.focus();
        }

        function closeProjectForm() {
            projectForm.hidden = true;
            editingProjectId = null;
            projectIdInput.value = '';
            projectNameInput.value = '';
            projectDescInput.value = '';
        }

        async function submitProjectForm(ev) {
            ev.preventDefault();
            if (busy) return;
            const name = projectNameInput.value.trim();
            const description = projectDescInput.value.trim();
            const projectId = projectIdInput.value.trim();
            if (!name) {
                showError(projectMsgEl, 'Name is required.');
                return;
            }
            busy = true;
            clearMessage(projectMsgEl);
            let res;
            try {
                if (editingProjectId) {
                    const payload = { name: name };
                    if (description) payload.description = description;
                    res = await api.updateProject(editingProjectId, payload);
                } else {
                    const payload = { name: name };
                    if (description) payload.description = description;
                    if (projectId) payload.projectId = projectId;
                    res = await api.createProject(payload);
                }
            } catch (err) {
                showError(projectMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(projectMsgEl, editingProjectId ? 'Project updated' : 'Project created');
                closeProjectForm();
                await renderProjects();
            } else {
                showError(
                    projectMsgEl,
                    extractError(res.body) || 'Save failed (HTTP ' + res.status + ')'
                );
            }
        }

        async function archiveProject(projectId) {
            if (!projectId || busy) return;
            // eslint-disable-next-line no-alert
            if (!window.confirm('Archive project "' + projectId + '"?')) return;
            busy = true;
            clearMessage(projectMsgEl);
            let res;
            try {
                res = await api.archiveProject(projectId);
            } catch (err) {
                showError(projectMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(projectMsgEl, 'Archived ' + projectId);
                await renderProjects();
            } else {
                showError(
                    projectMsgEl,
                    extractError(res.body) || 'Archive failed (HTTP ' + res.status + ')'
                );
            }
        }

        projectNewBtn.addEventListener('click', function () {
            openProjectForm(null);
        });
        projectRefreshBtn.addEventListener('click', function () {
            renderProjects();
        });
        projectCancelBtn.addEventListener('click', closeProjectForm);
        projectForm.addEventListener('submit', submitProjectForm);
        projectContextSaveBtn.addEventListener('click', saveProjectContext);
        projectContextCloseBtn.addEventListener('click', closeProjectContext);

        // --- Agents control center (Option B, Phase 3) ---------------
        //
        // One row per pipeline role (union of the /agent-roles vocabulary
        // and any roles present on agent records), each showing the
        // EFFECTIVE model/provider/persona the orchestrator resolves on
        // the next spawn. The newest record per role wins — mirroring the
        // orchestrator's AgentConfigResolver (ORDER BY updated_at DESC).
        // Older duplicates render dimmed as "shadowed".

        const agentListEl = document.getElementById('agent-list');
        const agentMsgEl = document.getElementById('agent-message');
        const agentForm = document.getElementById('agent-form');
        const agentIdInput = document.getElementById('agent-id-input');
        const agentNameInput = document.getElementById('agent-name-input');
        const agentRoleInput = document.getElementById('agent-role-input');
        const agentProviderInput = document.getElementById('agent-provider-input');
        const agentModelInput = document.getElementById('agent-model-input');
        const agentPromptInput = document.getElementById('agent-prompt-input');
        const agentPromptLabel = document.getElementById('agent-prompt-label');
        const agentPromptHint = document.getElementById('agent-prompt-hint');
        const agentMdProfileBar = document.getElementById('agent-md-profile-bar');
        const agentMdState = document.getElementById('agent-md-state');
        const agentMdShowDefaultBtn = document.getElementById('agent-md-show-default-btn');
        const agentMdAckBtn = document.getElementById('agent-md-ack-btn');
        const agentMdResetBtn = document.getElementById('agent-md-reset-btn');
        // Persona "Show default": the operator's text + editability are
        // parked while the read-only default is on screen.
        let agentMdShowingDefault = false;
        let agentMdMine = '';
        let agentMdMineReadOnly = false;
        let agentMdLayer = null;
        const agentRoleDatalist = document.getElementById('agent-role-options');
        const agentNewBtn = document.getElementById('agent-new-btn');
        const agentRefreshBtn = document.getElementById('agent-refresh-btn');
        const agentCancelBtn = document.getElementById('agent-cancel-btn');
        const agentMdBtn = document.getElementById('agent-md-btn');
        const agentMdEditor = document.getElementById('agent-md-editor');
        const agentMdPath = document.getElementById('agent-md-path');
        const agentMdGenerateRow = document.getElementById('agent-md-generate-row');
        const agentMdPurpose = document.getElementById('agent-md-purpose');
        const agentMdPurposeLabel = document.getElementById('agent-md-purpose-label');
        const agentMdGenerateBtn = document.getElementById('agent-md-generate-btn');
        const agentMdContent = document.getElementById('agent-md-content');
        const agentMdSaveBtn = document.getElementById('agent-md-save-btn');
        const agentMdCloseBtn = document.getElementById('agent-md-close-btn');
        const agentMdMsg = document.getElementById('agent-md-message');
        // Role whose file the MD editor currently holds + whether the file
        // exists on disk (true = revise mode, false = author mode).
        let agentMdRole = null;
        let agentMdExists = false;

        let editingAgentId = null;
        let cachedProviders = [];
        // Last GET /agent-roles body: { roles, fallbackProvider, fallbackModel }.
        let cachedRoles = { roles: [], fallbackProvider: null, fallbackModel: null };

        async function refreshProviders() {
            const res = await api.getAgentProviders();
            cachedProviders =
                res.ok && res.body && Array.isArray(res.body.providers) ? res.body.providers : [];
            agentProviderInput.replaceChildren();
            // '' = inherit: fall through to AGENT_RUNNER_<ROLE> / AGENT_RUNNER.
            agentProviderInput.appendChild(makeOption('', '(inherit — env / fallback)'));
            for (const p of cachedProviders) {
                agentProviderInput.appendChild(makeOption(p, p));
            }
        }

        function roleInfoFor(role) {
            for (const r of cachedRoles.roles) {
                if (r.role === role) return r;
            }
            return null;
        }

        async function renderAgents() {
            clearMessage(agentMsgEl);
            agentListEl.replaceChildren();
            if (cachedProviders.length === 0) {
                await refreshProviders();
            }
            const results = await Promise.all([api.listAgents(), api.getAgentRoles()]);
            const agentsRes = results[0];
            const rolesRes = results[1];
            if (!agentsRes.ok) {
                if (agentsRes.status === 404) {
                    appendEmpty(agentListEl, 'No agent list endpoint available yet.');
                } else {
                    showError(
                        agentMsgEl,
                        'Failed to load agents (HTTP ' + agentsRes.status + ')'
                    );
                }
                return;
            }
            cachedRoles =
                rolesRes.ok && rolesRes.body && Array.isArray(rolesRes.body.roles)
                    ? rolesRes.body
                    : { roles: [], fallbackProvider: null, fallbackModel: null };
            agentRoleDatalist.replaceChildren();
            for (const r of cachedRoles.roles) {
                agentRoleDatalist.appendChild(makeOption(r.role, r.role));
            }

            const agents = extractList(agentsRes.body, ['agents', 'items']);
            const grouped = groupAgentsByRole(agents);
            const roleNames = Object.create(null);
            for (const r of cachedRoles.roles) roleNames[r.role] = true;
            for (const role of Object.keys(grouped.byRole)) roleNames[role] = true;
            const allRoles = Object.keys(roleNames).sort();

            if (allRoles.length === 0 && grouped.orphans.length === 0) {
                appendEmpty(agentListEl, 'No roles or agents found.');
                return;
            }
            for (const role of allRoles) {
                const entry = grouped.byRole[role];
                agentListEl.appendChild(
                    renderRoleRow(role, entry ? entry.active : null, roleInfoFor(role))
                );
                const shadowed = entry ? entry.shadowed : [];
                for (const s of shadowed) {
                    agentListEl.appendChild(renderShadowedRow(role, s));
                }
            }
            for (const orphan of grouped.orphans) {
                agentListEl.appendChild(renderOrphanRow(orphan));
            }
        }

        function effectiveChip(label, resolved) {
            const wrap = document.createElement('span');
            const val = document.createElement('span');
            val.textContent = label + ' ' + resolved.value + ' ';
            const src = document.createElement('span');
            src.className = 'src';
            src.textContent = '(' + sourceLabel(resolved.source) + ')';
            wrap.appendChild(val);
            wrap.appendChild(src);
            return wrap;
        }

        function sourceLabel(source) {
            if (source === 'agent') return 'Agent';
            if (source === 'pipeline') return 'pipeline default';
            if (source === 'pipeline-developer') return 'pipeline developer default';
            if (source === 'env') return 'env';
            if (source === 'env-fallback') return 'env fallback';
            if (source === 'file') return 'file default';
            if (source === 'runner-default') return 'runner default';
            if (source === 'provider-default') return 'provider default';
            return source;
        }

        function renderRoleRow(role, agent, info) {
            const li = document.createElement('li');
            li.className = 'entity-row' + (agent ? '' : ' unconfigured');
            const meta = document.createElement('div');
            meta.className = 'entity-meta';
            const name = document.createElement('span');
            name.className = 'entity-name';
            name.textContent = role;
            const sub = document.createElement('span');
            sub.className = 'entity-sub';
            sub.textContent = agent
                ? (agent.name || '(unnamed)') + ' · ' + (agent.agentId || '')
                : 'no agent record — inherits defaults';
            const eff = document.createElement('div');
            eff.className = 'effective';
            const resolved = computeEffective(agent, info, cachedRoles);
            eff.appendChild(effectiveChip('model', resolved.model));
            eff.appendChild(effectiveChip('provider', resolved.provider));
            eff.appendChild(effectiveChip('persona', resolved.persona));
            meta.appendChild(name);
            meta.appendChild(sub);
            meta.appendChild(eff);

            const actions = document.createElement('div');
            actions.className = 'entity-actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.textContent = agent ? 'Edit' : 'Configure';
            editBtn.addEventListener('click', function () {
                openAgentForm(agent || { role: role, name: role });
            });
            actions.appendChild(editBtn);
            if (agent && agent.agentId) {
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'danger';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', function () {
                    deleteAgent(agent.agentId);
                });
                actions.appendChild(delBtn);
            }

            li.appendChild(meta);
            li.appendChild(actions);
            return li;
        }

        function renderShadowedRow(role, a) {
            const li = document.createElement('li');
            li.className = 'entity-row shadowed';
            const meta = document.createElement('div');
            meta.className = 'entity-meta';
            const name = document.createElement('span');
            name.className = 'entity-name';
            name.textContent = a.name || a.agentId || '(unnamed)';
            const sub = document.createElement('span');
            sub.className = 'entity-sub';
            sub.textContent =
                (a.agentId ? a.agentId + ' · ' : '')
                + 'shadowed — a newer record for role "' + role + '" wins';
            meta.appendChild(name);
            meta.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'entity-actions';
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'danger';
            delBtn.textContent = 'Delete';
            delBtn.disabled = !a.agentId;
            delBtn.addEventListener('click', function () {
                deleteAgent(a.agentId);
            });
            actions.appendChild(delBtn);

            li.appendChild(meta);
            li.appendChild(actions);
            return li;
        }

        function renderOrphanRow(a) {
            const li = document.createElement('li');
            li.className = 'entity-row';
            const meta = document.createElement('div');
            meta.className = 'entity-meta';
            const name = document.createElement('span');
            name.className = 'entity-name';
            name.textContent = a.name || a.agentId || '(unnamed)';
            const sub = document.createElement('span');
            sub.className = 'entity-sub';
            sub.textContent = (a.agentId ? a.agentId + ' · ' : '') + 'no role — never resolved';
            meta.appendChild(name);
            meta.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'entity-actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', function () {
                openAgentForm(a);
            });
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'danger';
            delBtn.textContent = 'Delete';
            delBtn.disabled = !a.agentId;
            delBtn.addEventListener('click', function () {
                deleteAgent(a.agentId);
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            li.appendChild(meta);
            li.appendChild(actions);
            return li;
        }

        // After `profile init` personas are files in the profile and the
        // pipeline no longer reads the Agents-panel prompt at all — so the
        // field goes away rather than accepting text that would be ignored.
        function promptFieldRetired() {
            return !!(profileState.active && profileState.initialised);
        }

        function applyAgentPromptMode() {
            const retired = promptFieldRetired();
            agentPromptInput.hidden = retired;
            agentPromptLabel.hidden = retired;
            updatePromptHint();
        }

        function updatePromptHint() {
            if (promptFieldRetired()) {
                agentPromptHint.textContent =
                    'Personas are files in your profile - use "Edit MD file" to change this role\'s persona.';
                return;
            }
            const info = roleInfoFor(agentRoleInput.value.trim());
            agentPromptHint.textContent =
                info && info.personaFile
                    ? 'Empty = use the agents/' + info.role + '.CLAUDE.md file default.'
                    : 'Empty = built-in minimal persona (no persona file found for this role).';
        }

        function openAgentForm(existing) {
            agentForm.hidden = false;
            // The persona block belongs to the previously selected role —
            // hide it until the operator clicks "Edit MD file" again.
            closeAgentMdEditor();
            editingAgentId = existing ? existing.agentId || null : null;
            agentIdInput.value = existing ? existing.agentId || '' : '';
            agentIdInput.disabled = !!editingAgentId;
            agentNameInput.value = existing ? existing.name || '' : '';
            agentRoleInput.value = existing ? existing.role || '' : '';
            agentProviderInput.value = existing && existing.provider ? existing.provider : '';
            agentModelInput.value = existing ? existing.model || '' : '';
            agentPromptInput.value = existing ? existing.prompt || '' : '';
            updatePromptHint();
            agentNameInput.focus();
        }

        function closeAgentForm() {
            agentForm.hidden = true;
            closeAgentMdEditor();
            editingAgentId = null;
            agentIdInput.value = '';
            agentNameInput.value = '';
            agentRoleInput.value = '';
            agentProviderInput.value = '';
            agentModelInput.value = '';
            agentPromptInput.value = '';
        }

        async function submitAgentForm(ev) {
            ev.preventDefault();
            if (busy) return;
            const name = agentNameInput.value.trim();
            const role = agentRoleInput.value.trim();
            const provider = agentProviderInput.value;
            const model = agentModelInput.value.trim();
            const prompt = agentPromptInput.value;
            const agentId = agentIdInput.value.trim();
            if (!name || !role) {
                showError(agentMsgEl, 'Name and role are required.');
                return;
            }
            busy = true;
            clearMessage(agentMsgEl);
            // provider/model/prompt are ALWAYS sent, '' included: on update
            // the projection keeps old values for omitted fields (COALESCE),
            // so '' is how a field is cleared back to "inherit".
            const payload = {
                name: name,
                role: role,
                provider: provider,
                model: model
            };
            // Not sent once personas are profile files — the server would
            // drop it anyway, and say so.
            if (!promptFieldRetired()) payload.prompt = prompt;
            let res;
            try {
                if (editingAgentId) {
                    res = await api.updateAgent(editingAgentId, payload);
                } else {
                    if (agentId) payload.agentId = agentId;
                    res = await api.createAgent(payload);
                }
            } catch (err) {
                showError(agentMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(agentMsgEl, editingAgentId ? 'Agent updated' : 'Agent created');
                closeAgentForm();
                await renderAgents();
            } else {
                showError(
                    agentMsgEl,
                    extractError(res.body) || 'Save failed (HTTP ' + res.status + ')'
                );
            }
        }

        async function deleteAgent(agentId) {
            if (!agentId || busy) return;
            // eslint-disable-next-line no-alert
            if (!window.confirm('Delete agent record "' + agentId + '"? The role falls back to its defaults.')) {
                return;
            }
            busy = true;
            clearMessage(agentMsgEl);
            let res;
            try {
                res = await api.deleteAgent(agentId);
            } catch (err) {
                showError(agentMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(agentMsgEl, 'Deleted ' + agentId);
                await renderAgents();
            } else {
                showError(
                    agentMsgEl,
                    extractError(res.body) || 'Delete failed (HTTP ' + res.status + ')'
                );
            }
        }

        agentNewBtn.addEventListener('click', function () {
            openAgentForm(null);
        });
        agentRefreshBtn.addEventListener('click', function () {
            renderAgents();
        });
        agentCancelBtn.addEventListener('click', closeAgentForm);
        agentForm.addEventListener('submit', submitAgentForm);
        agentRoleInput.addEventListener('input', function () {
            updatePromptHint();
            // Typing a different role makes the open persona block stale.
            if (agentMdRole !== null && agentRoleInput.value.trim() !== agentMdRole) {
                closeAgentMdEditor();
            }
        });

        // --- Persona MD editor ----------------------------------------
        //
        // "Edit MD file" on the agent form loads agents/<role>.CLAUDE.md
        // (the persona the orchestrator falls back to when the Agent
        // record's prompt is empty). Missing file → author mode: a
        // purpose/responsibilities textbox + "Generate MD file" drafts a
        // persona (claude CLI on the API machine) into the editor for
        // review. Existing file → revise mode: the content is shown
        // read-only and the operator gives change INSTRUCTIONS +
        // "Regenerate MD file"; the revision (current file + instructions)
        // lands in the editor for review. "Save MD file" writes via PUT.

        function closeAgentMdEditor() {
            agentMdEditor.hidden = true;
            agentMdRole = null;
            agentMdExists = false;
            agentMdShowingDefault = false;
            agentMdLayer = null;
            agentMdProfileBar.hidden = true;
            agentMdPurpose.value = '';
            agentMdContent.value = '';
            clearMessage(agentMdMsg);
        }

        function setAgentMdMode(exists) {
            agentMdExists = exists;
            // display:contents lets the row's children participate in the
            // parent form-grid; the hidden attribute can't express that.
            agentMdGenerateRow.style.display = 'contents';
            if (exists) {
                agentMdPurposeLabel.textContent = 'Instructions';
                agentMdPurpose.placeholder =
                    'Describe what should change — the file is regenerated from '
                    + 'the current content plus these instructions…';
                agentMdGenerateBtn.textContent = 'Regenerate MD file';
                agentMdContent.readOnly = true;
            } else {
                agentMdPurposeLabel.textContent = 'Purpose & responsibilities';
                agentMdPurpose.placeholder =
                    'Describe what this agent is for, what it receives, and what '
                    + 'it must produce…';
                agentMdGenerateBtn.textContent = 'Generate MD file';
                agentMdContent.readOnly = false;
            }
        }

        async function openAgentMdEditor() {
            const role = agentRoleInput.value.trim();
            if (!role) {
                showError(agentMsgEl, 'Enter a role first — the MD file is per role.');
                return;
            }
            clearMessage(agentMdMsg);
            let res;
            try {
                res = await api.getAgentMd(role);
            } catch (err) {
                showError(agentMsgEl, 'Network error: ' + (err && err.message));
                return;
            }
            if (!res.ok) {
                showError(
                    agentMsgEl,
                    extractError(res.body) || 'Failed to load MD file (HTTP ' + res.status + ')'
                );
                return;
            }
            agentMdRole = role;
            agentMdEditor.hidden = false;
            agentMdPath.textContent =
                res.body.path + (res.body.exists ? '' : ' — no file yet');
            agentMdContent.value = res.body.content || '';
            setAgentMdMode(!!res.body.exists);
            agentMdShowingDefault = false;
            updateAgentMdProfileBar(res.body);
            if (res.body.exists) {
                showInfo(
                    agentMdMsg,
                    'Give instructions and regenerate — the file is rewritten from '
                        + 'the current content plus your instructions.'
                );
            } else {
                showInfo(
                    agentMdMsg,
                    'No persona file for "' + role + '" yet. Describe its purpose and '
                        + 'generate a draft, or write the file directly below.'
                );
            }
            agentMdPurpose.focus();
        }

        async function generateAgentMdDraft() {
            if (busy || !agentMdRole) return;
            const text = agentMdPurpose.value.trim();
            if (!text) {
                showError(
                    agentMdMsg,
                    agentMdExists
                        ? 'Describe what should change first.'
                        : 'Describe the agent\'s purpose and responsibilities first.'
                );
                return;
            }
            busy = true;
            agentMdGenerateBtn.disabled = true;
            // Unmissable busy state: the button itself narrates (the info
            // message at the bottom of the form was easy to overlook —
            // field report: "clicked Regenerate, nothing seems to happen").
            var idleLabel = agentMdGenerateBtn.textContent;
            agentMdGenerateBtn.textContent = agentMdExists
                ? 'Regenerating… (can take a few minutes)'
                : 'Generating… (can take a few minutes)';
            showInfo(agentMdMsg, 'Generating draft — this can take a few minutes…');
            let res;
            try {
                res = agentMdExists
                    ? await api.regenerateAgentMd(agentMdRole, text)
                    : await api.generateAgentMd(agentMdRole, text);
            } catch (err) {
                showError(agentMdMsg, 'Network error: ' + (err && err.message));
                busy = false;
                agentMdGenerateBtn.disabled = false;
                agentMdGenerateBtn.textContent = idleLabel;
                return;
            }
            busy = false;
            agentMdGenerateBtn.disabled = false;
            agentMdGenerateBtn.textContent = idleLabel;
            if (res.ok && res.body && typeof res.body.content === 'string') {
                agentMdContent.value = res.body.content;
                // The draft is the operator's to polish before saving —
                // revise mode kept the textarea read-only, which locked
                // them out of their own draft.
                agentMdContent.readOnly = false;
                showInfo(
                    agentMdMsg,
                    'Draft generated — review below, then Save MD file. '
                        + '(Not written to disk until you save.)'
                );
            } else {
                showError(
                    agentMdMsg,
                    extractError(res.body) || 'Generation failed (HTTP ' + res.status + ')'
                );
            }
        }

        async function saveAgentMdFile() {
            if (busy || !agentMdRole) return;
            const content = agentMdContent.value;
            if (!content.trim()) {
                showError(agentMdMsg, 'The file content is empty — nothing to save.');
                return;
            }
            busy = true;
            let res;
            try {
                res = await api.putAgentMd(agentMdRole, content);
            } catch (err) {
                showError(agentMdMsg, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                agentMdPath.textContent = res.body && res.body.path ? res.body.path : '';
                // The file now exists — switch to instruction-driven
                // revise mode for any follow-up change.
                setAgentMdMode(true);
                agentMdPurpose.value = '';
                const again = await api.getAgentMd(agentMdRole);
                if (again.ok && again.body) updateAgentMdProfileBar(again.body);
                showInfo(
                    agentMdMsg,
                    (res.body && res.body.customised ? 'Saved to your profile. ' : 'Saved. ')
                        + 'Applies on the next spawn of this role.'
                );
                await renderAgents();
            } else {
                showError(
                    agentMdMsg,
                    extractError(res.body) || 'Save failed (HTTP ' + res.status + ')'
                );
            }
        }

        function updateAgentMdProfileBar(body) {
            if (!profileState.active || !body) {
                agentMdProfileBar.hidden = true;
                return;
            }
            agentMdLayer = {
                customised: !!body.customised,
                defaultChanged: !!body.defaultChanged,
                hasDefault: !!body.hasDefault,
            };
            agentMdProfileBar.hidden = false;
            agentMdState.textContent = agentMdShowingDefault
                ? 'Showing the built-in default (read-only).'
                : describeLayer(agentMdLayer)
                    + (body.extended ? ' An .extend.md in your profile adds to it.' : '');
            agentMdState.className = badgeClass(agentMdLayer);
            configureLayerButtons(
                agentMdLayer, agentMdShowingDefault,
                agentMdShowDefaultBtn, agentMdAckBtn, agentMdResetBtn
            );
        }

        async function toggleAgentMdDefault() {
            if (busy || !agentMdRole) return;
            if (agentMdShowingDefault) {
                agentMdContent.value = agentMdMine;
                agentMdContent.readOnly = agentMdMineReadOnly;
                agentMdSaveBtn.disabled = false;
                agentMdShowingDefault = false;
                clearMessage(agentMdMsg);
                updateAgentMdProfileBar(Object.assign({ extended: false }, agentMdLayer));
                return;
            }
            const res = await api.getAgentMdDefault(agentMdRole);
            if (!res.ok || !res.body) {
                showError(agentMdMsg, extractError(res.body) || 'Could not load the default (HTTP ' + res.status + ')');
                return;
            }
            agentMdMine = agentMdContent.value;
            agentMdMineReadOnly = agentMdContent.readOnly;
            agentMdContent.value = res.body.content || '';
            // Saving now would copy the default INTO the profile and freeze it.
            agentMdContent.readOnly = true;
            agentMdSaveBtn.disabled = true;
            agentMdShowingDefault = true;
            updateAgentMdProfileBar(Object.assign({ extended: false }, agentMdLayer));
        }

        async function acknowledgeAgentMdDefault() {
            if (busy || !agentMdRole) return;
            const res = await api.acknowledgeDefault('agents/' + agentMdRole + '.CLAUDE.md');
            if (!res.ok) {
                showError(agentMdMsg, extractError(res.body) || 'Could not mark as reviewed (HTTP ' + res.status + ')');
                return;
            }
            const again = await api.getAgentMd(agentMdRole);
            if (again.ok && again.body) updateAgentMdProfileBar(again.body);
            showInfo(agentMdMsg, 'Marked as reviewed. You will be told again if the default changes.');
        }

        async function resetAgentMdToDefault() {
            if (busy || !agentMdRole) return;
            const role = agentMdRole;
            const prompt = agentMdLayer && !agentMdLayer.hasDefault
                ? 'Remove the "' + role + '" persona from your profile? There is no built-in version, so the role will have none.'
                : 'Reset the "' + role + '" persona to the built-in default? Your copy in the profile is deleted.';
            // eslint-disable-next-line no-alert
            if (!window.confirm(prompt)) return;
            const res = await api.resetAgentMd(role);
            if (!res.ok) {
                showError(agentMdMsg, extractError(res.body) || 'Reset failed (HTTP ' + res.status + ')');
                return;
            }
            await openAgentMdEditor();
            await renderAgents();
            showInfo(agentMdMsg, 'Back on the built-in default. Applies on the next spawn of this role.');
        }

        agentMdShowDefaultBtn.addEventListener('click', toggleAgentMdDefault);
        agentMdAckBtn.addEventListener('click', acknowledgeAgentMdDefault);
        agentMdResetBtn.addEventListener('click', resetAgentMdToDefault);

        agentMdBtn.addEventListener('click', openAgentMdEditor);
        agentMdGenerateBtn.addEventListener('click', generateAgentMdDraft);
        agentMdSaveBtn.addEventListener('click', saveAgentMdFile);
        agentMdCloseBtn.addEventListener('click', closeAgentMdEditor);

        // --- Settings editor (Phase 5) --------------------------------
        //
        // Curated runtime settings, stored in the config store and
        // overlaid onto the orchestrator's env at boot. Secrets are
        // WRITE-ONLY: the API reports presence, never the value, and the
        // input stays blank with a "set" placeholder.

        const settingListEl = document.getElementById('setting-list');
        const settingMsgEl = document.getElementById('setting-message');
        const settingFootnoteEl = document.getElementById('setting-footnote');
        const settingRefreshBtn = document.getElementById('setting-refresh-btn');

        // --- GitHub accounts ----------------------------------------
        //
        // Editing happens in memory and lands on Save, because the three
        // fields of an account are only meaningful together: saving per
        // keystroke would persist half-typed config dirs and write a path
        // that does not exist yet while the operator is still typing it.
        //
        // No field here is secret. An account names a `gh` config dir;
        // `gh` holds the credential.
        let ghAccountDraft = [];

        const ghAccountListEl = document.getElementById('gh-account-list');
        const ghAccountMsgEl = document.getElementById('gh-account-message');
        const ghAccountFootnoteEl = document.getElementById('gh-account-footnote');
        const ghAccountAddBtn = document.getElementById('gh-account-add-btn');
        const ghAccountSaveBtn = document.getElementById('gh-account-save-btn');
        const ghAccountRefreshBtn = document.getElementById('gh-account-refresh-btn');

        async function renderGithubAccounts() {
            clearMessage(ghAccountMsgEl);
            const res = await api.listGithubAccounts();
            if (!res.ok) {
                showError(ghAccountMsgEl, 'Failed to load GitHub accounts (HTTP ' + res.status + ')');
                return;
            }
            const body = res.body || {};
            const list = Array.isArray(body.accounts) ? body.accounts : [];
            ghAccountDraft = list.map(function (a) {
                return {
                    id: a.id || '',
                    ghConfigDir: a.ghConfigDir || '',
                    commitName: a.commitName || '',
                    commitEmail: a.commitEmail || '',
                    configDirExists: a.configDirExists === true,
                    status: null
                };
            });
            // Parse problems are entries the pipeline could NOT use. Shown
            // because an account that silently vanished from the list is
            // indistinguishable from one that was never added.
            const problems = Array.isArray(body.problems) ? body.problems : [];
            if (problems.length > 0) {
                showError(ghAccountMsgEl, problems.map(function (p) {
                    return (p.id ? p.id + ': ' : '') + p.message;
                }).join(' / '));
            }
            paintGithubAccounts();
        }

        function paintGithubAccounts() {
            ghAccountFootnoteEl.textContent =
                'Each account points at a directory you ran `gh auth login` into - no token '
                + 'is stored here. Repos choose their account on the board. Save writes to '
                + 'your operator profile, never to the repo.';
            ghAccountListEl.replaceChildren();
            if (ghAccountDraft.length === 0) {
                appendEmpty(ghAccountListEl, 'No accounts declared - the pipeline uses this machine\u2019s own gh login.');
                return;
            }
            ghAccountDraft.forEach(function (account, index) {
                ghAccountListEl.appendChild(ghAccountRow(account, index));
            });
        }

        const GH_ACCOUNT_FIELDS = [
            { key: 'id', label: 'Account id', hint: 'letters, digits, dash, underscore' },
            { key: 'ghConfigDir', label: 'gh config dir', hint: 'the directory you ran `gh auth login` into' },
            { key: 'commitName', label: 'Commit name', hint: '' },
            // The one way to get this wrong and not notice: the author
            // line is just text, and GitHub matches it to an account by
            // email.
            { key: 'commitEmail', label: 'Commit email', hint: 'must be verified on that GitHub account, or commits are not attributed' }
        ];

        function ghAccountRow(account, index) {
            const li = document.createElement('li');
            li.className = 'entity-row';

            GH_ACCOUNT_FIELDS.forEach(function (field) {
                const wrap = document.createElement('label');
                wrap.className = 'entity-field';
                const span = document.createElement('span');
                span.textContent = field.label;
                wrap.appendChild(span);
                const input = document.createElement('input');
                input.type = 'text';
                input.value = account[field.key] || '';
                if (field.hint) input.title = field.hint;
                input.addEventListener('input', function () {
                    ghAccountDraft[index][field.key] = input.value;
                    // The on-disk flag described the SAVED value; once the
                    // path is edited it says nothing about what is typed.
                    if (field.key === 'ghConfigDir') {
                        ghAccountDraft[index].configDirExists = null;
                        ghAccountDraft[index].status = null;
                    }
                });
                wrap.appendChild(input);
                li.appendChild(wrap);
            });

            const actions = document.createElement('div');
            actions.className = 'entity-actions';

            // A directory that exists proves nothing about being logged
            // in, so the cheap on-disk check and the Test result are
            // shown as separate facts.
            const status = document.createElement('span');
            status.className = 'entity-status';
            if (account.status) {
                status.textContent = account.status.ok
                    ? '\u2713 ' + account.status.login
                    : '\u2717 ' + account.status.error;
            } else if (account.configDirExists === false) {
                status.textContent = '\u2717 config dir not found';
            } else {
                status.textContent = '';
            }
            actions.appendChild(status);

            const testBtn = document.createElement('button');
            testBtn.type = 'button';
            testBtn.textContent = 'Test';
            testBtn.title = 'Run `gh api user` as this account and show the login it reports';
            testBtn.addEventListener('click', async function () {
                // Tests the SAVED account: the route reads the config
                // file, so an unsaved edit is not what gets checked.
                testBtn.disabled = true;
                status.textContent = 'testing...';
                try {
                    const res = await api.testGithubAccount(account.id);
                    const result = res.body || {};
                    ghAccountDraft[index].status = {
                        ok: result.ok === true,
                        login: result.login || '',
                        error: result.error || ('HTTP ' + res.status)
                    };
                } catch (err) {
                    ghAccountDraft[index].status = {
                        ok: false,
                        error: (err && err.message) || 'test failed'
                    };
                }
                testBtn.disabled = false;
                paintGithubAccounts();
            });
            actions.appendChild(testBtn);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', function () {
                // In-memory until Save, so a mis-click is undone with
                // Refresh rather than by re-typing the account.
                ghAccountDraft.splice(index, 1);
                paintGithubAccounts();
                showInfo(ghAccountMsgEl, 'Removed - click Save to apply, or Refresh to undo.');
            });
            actions.appendChild(removeBtn);

            li.appendChild(actions);
            return li;
        }

        if (ghAccountAddBtn) {
            ghAccountAddBtn.addEventListener('click', function () {
                ghAccountDraft.push({
                    id: '',
                    ghConfigDir: '',
                    commitName: '',
                    commitEmail: '',
                    configDirExists: null,
                    status: null
                });
                paintGithubAccounts();
            });
        }
        if (ghAccountRefreshBtn) {
            ghAccountRefreshBtn.addEventListener('click', function () {
                void renderGithubAccounts();
            });
        }
        if (ghAccountSaveBtn) {
            ghAccountSaveBtn.addEventListener('click', async function () {
                ghAccountSaveBtn.disabled = true;
                clearMessage(ghAccountMsgEl);
                try {
                    const res = await api.putGithubAccounts(ghAccountDraft.map(function (a) {
                        return {
                            id: a.id,
                            ghConfigDir: a.ghConfigDir,
                            commitName: a.commitName,
                            commitEmail: a.commitEmail
                        };
                    }));
                    if (!res.ok) {
                        showError(ghAccountMsgEl, extractError(res.body) || 'Save failed (HTTP ' + res.status + ')');
                    } else {
                        showInfo(ghAccountMsgEl, 'Saved to your profile - restart the worker for running tasks to pick it up.');
                        await renderGithubAccounts();
                    }
                } catch (err) {
                    showError(ghAccountMsgEl, (err && err.message) || 'Save failed');
                }
                ghAccountSaveBtn.disabled = false;
            });
        }

        async function renderSettings() {
            clearMessage(settingMsgEl);
            settingListEl.replaceChildren();
            const res = await api.listSettings();
            if (!res.ok) {
                if (res.status === 404) {
                    appendEmpty(settingListEl, 'No settings endpoint available yet.');
                } else {
                    showError(settingMsgEl, 'Failed to load settings (HTTP ' + res.status + ')');
                }
                return;
            }
            const body = res.body || {};
            settingFootnoteEl.textContent = body.note || '';
            const settings = Array.isArray(body.settings) ? body.settings : [];
            if (settings.length === 0) {
                appendEmpty(settingListEl, 'No editable settings.');
                return;
            }
            let currentCategory = null;
            for (const s of settings) {
                if (s.category !== currentCategory) {
                    currentCategory = s.category;
                    const section = document.createElement('li');
                    section.className = 'section-row';
                    section.textContent = s.category;
                    settingListEl.appendChild(section);
                }
                settingListEl.appendChild(renderSettingRow(s));
            }
        }

        function settingSourceLabel(s) {
            if (s.source === 'override') return 'override (applies on restart)';
            if (s.source === 'env') return 'from .env';
            return 'not set';
        }

        function renderSettingRow(s) {
            const li = document.createElement('li');
            li.className = 'entity-row';
            const meta = document.createElement('div');
            meta.className = 'entity-meta';
            const name = document.createElement('span');
            name.className = 'entity-name';
            name.textContent = s.label || s.key;
            const sub = document.createElement('span');
            sub.className = 'entity-sub';
            sub.textContent = s.key + ' · ' + settingSourceLabel(s);
            const desc = document.createElement('span');
            desc.className = 'entity-sub';
            desc.textContent = s.description || '';
            meta.appendChild(name);
            meta.appendChild(sub);
            if (s.description) meta.appendChild(desc);

            const actions = document.createElement('div');
            actions.className = 'entity-actions';
            const input = document.createElement('input');
            input.className = 'setting-input';
            input.setAttribute('aria-label', s.key);
            if (s.secret) {
                // Never echoed: blank input; placeholder reports presence.
                input.type = 'password';
                input.autocomplete = 'new-password';
                input.placeholder = s.set ? '•••••• (set — write-only)' : '(not set)';
            } else {
                input.type = 'text';
                input.value = typeof s.value === 'string' ? s.value : '';
                input.placeholder = '(not set)';
            }
            actions.appendChild(input);

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.textContent = 'Save';
            saveBtn.dataset.action = 'save';
            saveBtn.addEventListener('click', function () {
                saveSetting(s, input.value);
            });
            actions.appendChild(saveBtn);

            if (s.source === 'override') {
                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'danger';
                clearBtn.textContent = 'Clear override';
                clearBtn.addEventListener('click', function () {
                    clearSetting(s);
                });
                actions.appendChild(clearBtn);
            }

            li.appendChild(meta);
            li.appendChild(actions);
            return li;
        }

        async function saveSetting(s, value) {
            const trimmed = (value || '').trim();
            if (!trimmed) {
                showError(
                    settingMsgEl,
                    s.key + ': enter a value (use "Clear override" to remove the stored one).'
                );
                return;
            }
            if (busy) return;
            busy = true;
            clearMessage(settingMsgEl);
            let res;
            try {
                res = await api.putSetting(s.key, trimmed, s.etag || undefined);
            } catch (err) {
                showError(settingMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(
                    settingMsgEl,
                    s.key + ' stored — restart the orchestrator to apply.'
                );
                await renderSettings();
            } else if (res.status === 409) {
                showError(
                    settingMsgEl,
                    s.key + ' changed elsewhere — refresh and retry.'
                );
            } else {
                showError(
                    settingMsgEl,
                    extractError(res.body) || 'Save failed (HTTP ' + res.status + ')'
                );
            }
        }

        async function clearSetting(s) {
            if (busy) return;
            // eslint-disable-next-line no-alert
            if (!window.confirm('Remove the stored override for ' + s.key + '? The .env value (if any) applies after the next restart.')) {
                return;
            }
            busy = true;
            clearMessage(settingMsgEl);
            let res;
            try {
                res = await api.deleteSetting(s.key);
            } catch (err) {
                showError(settingMsgEl, 'Network error: ' + (err && err.message));
                busy = false;
                return;
            }
            busy = false;
            if (res.ok) {
                showInfo(settingMsgEl, s.key + ' override removed.');
                await renderSettings();
            } else {
                showError(
                    settingMsgEl,
                    extractError(res.body) || 'Remove failed (HTTP ' + res.status + ')'
                );
            }
        }

        settingRefreshBtn.addEventListener('click', function () {
            renderSettings();
        });

        // --- ui helpers ---------------------------------------------

        function setStatus(kind, label) {
            statusDot.classList.remove('ready', 'error');
            if (kind) statusDot.classList.add(kind);
            statusLabel.textContent = label;
        }

        function showInfo(target, text) {
            target.classList.remove('error');
            target.classList.add('info');
            target.textContent = text;
        }

        function showError(target, text) {
            target.classList.remove('info');
            target.classList.add('error');
            target.textContent = text;
        }

        function clearMessage(target) {
            target.classList.remove('info', 'error');
            target.textContent = '';
        }

        function appendEmpty(listEl, text) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = text;
            listEl.appendChild(li);
        }

        function makeOption(value, label) {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            return o;
        }

        // --- go -----------------------------------------------------

        setStatus(null, 'loading…');
        showPanel('empty');
        bootstrap();
        refreshProfile();
    }

    // -----------------------------------------------------------------
    // Shared helpers (pure, no DOM).
    // -----------------------------------------------------------------

    function extractError(body) {
        if (body && typeof body === 'object' && typeof body.error === 'string') {
            return body.error;
        }
        return null;
    }

    function extractList(body, candidateKeys) {
        if (Array.isArray(body)) return body;
        if (body && typeof body === 'object') {
            for (const k of candidateKeys) {
                if (Array.isArray(body[k])) return body[k];
            }
        }
        return [];
    }

    /**
     * Group agent records by role, newest-updatedAt first — mirrors the
     * orchestrator's AgentConfigResolver (`ORDER BY updated_at DESC LIMIT 1`):
     * the newest non-deleted record per role is the one the pipeline consumes;
     * older duplicates are "shadowed". Records without a role are `orphans`
     * (the resolver never matches them).
     */
    function groupAgentsByRole(agents) {
        // Null-prototype map: role names are operator input, and a role like
        // "toString" or "__proto__" must behave as a plain key, not collide
        // with inherited Object.prototype members.
        const byRole = Object.create(null);
        const orphans = [];
        for (const a of agents || []) {
            if (!a || typeof a !== 'object') continue;
            const role = typeof a.role === 'string' && a.role.length > 0 ? a.role : null;
            if (!role) {
                orphans.push(a);
                continue;
            }
            if (!byRole[role]) {
                byRole[role] = { active: a, shadowed: [] };
            } else if ((a.updatedAt || 0) > (byRole[role].active.updatedAt || 0)) {
                byRole[role].shadowed.push(byRole[role].active);
                byRole[role].active = a;
            } else {
                byRole[role].shadowed.push(a);
            }
        }
        return { byRole: byRole, orphans: orphans };
    }

    /** Own-property lookup on a possibly JSON-parsed record; null when absent. */
    function ownValue(record, key) {
        if (!record || typeof record !== 'object') return null;
        return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
    }

    /**
     * Effective per-role resolution — mirrors the orchestrator's order (minus
     * a flow step's explicit `model:`, which still wins for that step):
     *
     *   provider: Agent.provider > AGENT_RUNNER_<ROLE> > AGENT_RUNNER/fake
     *   model:    Agent.model ('none' = inherit, like the runners) — then a
     *             PROVIDER-SPECIFIC chain: only claude-cli consults pipeline
     *             default_models; deepseek/cursor-cli have their own defaults
     *             (DEEPSEEK_MODEL_<ROLE>, CURSOR_MODEL_<ROLE>), so those rows
     *             show "(provider default)" rather than a wrong claude id. The
     *             claude-cli chain is default_models[role] >
     *             default_models.developer > CLAUDE_MODEL_<ROLE>/CLAUDE_MODEL >
     *             claude-sonnet-4-6.
     *   persona:  Agent.prompt > agents/<role>.CLAUDE.md > built-in minimal
     *
     * `agent` is the active record (or null), `info` the /agent-roles entry
     * (or null — a role only declared by an agent record), `fallbacks` the
     * /agent-roles top level. Roles outside the vocabulary still resolve env
     * overrides via the top-level envProviders/envModels maps, which the
     * manager-api scans exactly the way the orchestrator reads them.
     */
    function computeEffective(agent, info, fallbacks) {
        const fb = fallbacks || {};
        const ri = info || {};
        const roleName = String(
            ri.role || (agent && typeof agent.role === 'string' ? agent.role : '') || ''
        );
        const envProvider =
            ri.envProvider || (roleName ? ownValue(fb.envProviders, roleName) : null);
        const envModel =
            ri.envModel
            || (roleName ? ownValue(fb.envModels, roleName.toUpperCase()) : null)
            || fb.envModel
            || null;

        let provider;
        if (agent && typeof agent.provider === 'string' && agent.provider.length > 0) {
            provider = { value: agent.provider, source: 'agent' };
        } else if (envProvider) {
            provider = { value: envProvider, source: 'env' };
        } else {
            provider = { value: fb.fallbackProvider || 'fake', source: 'env-fallback' };
        }

        let model;
        if (
            agent
            && typeof agent.model === 'string'
            && agent.model.length > 0
            && agent.model !== 'none' // runners treat 'none' as no-override
        ) {
            model = { value: agent.model, source: 'agent' };
        } else if (provider.value === 'deepseek' || provider.value === 'cursor-cli') {
            // Those runners resolve their own defaults (DEEPSEEK_MODEL_<ROLE>/
            // CURSOR_MODEL_<ROLE>/built-ins) and never see pipeline
            // default_models — showing the claude chain here would be wrong.
            model = { value: '(' + provider.value + ' default)', source: 'provider-default' };
        } else if (provider.value === 'fake') {
            model = { value: '(fake runner)', source: 'provider-default' };
        } else if (ri.defaultModel) {
            model = { value: ri.defaultModel, source: 'pipeline' };
        } else if (fb.fallbackModel) {
            model = { value: fb.fallbackModel, source: 'pipeline-developer' };
        } else if (envModel) {
            model = { value: envModel, source: 'env' };
        } else {
            model = { value: 'claude-sonnet-4-6', source: 'runner-default' };
        }

        let persona;
        if (agent && typeof agent.prompt === 'string' && agent.prompt.length > 0) {
            persona = { value: agent.prompt.length + ' chars', source: 'agent' };
        } else if (ri.personaFile) {
            persona = { value: ri.role + '.CLAUDE.md', source: 'file' };
        } else {
            persona = { value: 'built-in', source: 'runner-default' };
        }

        return { model: model, provider: provider, persona: persona };
    }

    // -----------------------------------------------------------------
    // YAML dumper (preserved from AP-IFW-002).
    //
    // Minimal JSON-to-YAML emitter. Handles the shapes the manager-api
    // returns: nested mappings, sequences of scalars or mappings, and
    // primitive scalars. Strings are quoted only when they would
    // otherwise round-trip ambiguously (numbers, booleans, leading
    // whitespace, special chars). Good enough for editing pipeline.yaml
    // and flow YAML; not a general-purpose YAML library.
    // -----------------------------------------------------------------

    /**
     * The text to put in the editor for a loaded file, plus any loader
     * complaint to show beside it.
     *
     * Flows arrive as `{ name, raw, flow, error }` and the editor uses
     * `raw` — the file's exact bytes. It used to re-serialise the parsed
     * object, which meant every open->save round-trip silently dropped
     * the file's comments and rewrote its formatting; the flow YAMLs in
     * this repo are heavily commented, and that is documentation the
     * operator was losing just by opening a file and clicking Save.
     *
     * `error` is non-null when the loader rejected the file. The editor
     * still OPENS it — that is the whole point, since this is the tool
     * for repairing it — and shows the message so the operator knows
     * what to fix. Save re-validates server-side, so a broken file
     * cannot be made worse from here.
     *
     * Pipeline still round-trips through dumpYaml: it is served as a
     * parsed object and has not been given the same envelope.
     */
    function editorTextFor(kind, body) {
        if (kind !== 'pipeline' && body && typeof body.raw === 'string') {
            return { text: body.raw, error: body.error || null };
        }
        return { text: dumpYaml(body), error: null };
    }

    function dumpYaml(value) {
        if (value === null || value === undefined) return 'null\n';
        if (typeof value !== 'object') return formatScalar(value) + '\n';
        if (Array.isArray(value)) return dumpArray(value, 0);
        return dumpObject(value, 0);
    }

    function dumpObject(obj, indent) {
        const keys = Object.keys(obj);
        if (keys.length === 0) return ' '.repeat(indent) + '{}\n';
        let out = '';
        for (const k of keys) {
            const v = obj[k];
            const keyLine = ' '.repeat(indent) + formatKey(k) + ':';
            if (v === null || v === undefined) {
                out += keyLine + ' null\n';
            } else if (typeof v !== 'object') {
                out += keyLine + ' ' + formatScalar(v) + '\n';
            } else if (Array.isArray(v)) {
                if (v.length === 0) {
                    out += keyLine + ' []\n';
                } else {
                    out += keyLine + '\n' + dumpArray(v, indent);
                }
            } else {
                if (Object.keys(v).length === 0) {
                    out += keyLine + ' {}\n';
                } else {
                    out += keyLine + '\n' + dumpObject(v, indent + 2);
                }
            }
        }
        return out;
    }

    function dumpArray(arr, indent) {
        let out = '';
        for (const item of arr) {
            const pad = ' '.repeat(indent);
            if (item === null || item === undefined) {
                out += pad + '- null\n';
            } else if (typeof item !== 'object') {
                out += pad + '- ' + formatScalar(item) + '\n';
            } else if (Array.isArray(item)) {
                if (item.length === 0) {
                    out += pad + '- []\n';
                } else {
                    out += pad + '-\n' + dumpArray(item, indent + 2);
                }
            } else {
                const keys = Object.keys(item);
                if (keys.length === 0) {
                    out += pad + '- {}\n';
                } else {
                    const child = dumpObject(item, indent + 2);
                    const childLines = child.split('\n');
                    childLines[0] = pad + '- ' + childLines[0].slice(indent + 2);
                    out += childLines.join('\n');
                }
            }
        }
        return out;
    }

    function formatKey(k) {
        return needsQuoting(String(k)) ? JSON.stringify(String(k)) : String(k);
    }

    function formatScalar(v) {
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
        const s = String(v);
        if (needsQuoting(s)) return JSON.stringify(s);
        return s;
    }

    function needsQuoting(s) {
        if (s === '') return true;
        if (s === 'true' || s === 'false' || s === 'null' || s === 'yes' || s === 'no') return true;
        if (/^-?\d+(\.\d+)?$/.test(s)) return true;
        if (/^[\s]/.test(s) || /[\s]$/.test(s)) return true;
        if (/[:#&*!|>'"%@`,[\]{}]/.test(s)) return true;
        if (/[\n\r\t]/.test(s)) return true;
        return false;
    }

    // -----------------------------------------------------------------
    // Browser entry point + CommonJS export.
    //
    // The script tag in index.html loads this file at the end of <body>,
    // so DOM is already parsed by the time we run. Auto-bootstrap only
    // when `document` exists — Node test runs require the API in
    // isolation and never trigger UI setup.
    // -----------------------------------------------------------------

    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        bootstrapUi(makeApi());
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            makeApi: makeApi,
            extractError: extractError,
            extractList: extractList,
            groupAgentsByRole: groupAgentsByRole,
            computeEffective: computeEffective,
            dumpYaml: dumpYaml
        };
    }
})();
