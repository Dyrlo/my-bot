const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const filePath = process.env.BOT_DATA_PATH
    ? path.resolve(process.env.BOT_DATA_PATH)
    : path.join(__dirname, 'data', 'sessions.json');

const DEPARTMENT_LABELS = {
    acceptance: 'قبول توظيف',
    operations: 'مركز عمليات',
    internal_affairs: 'شؤون داخلية'
};
const DEPARTMENT_KEYS_BY_LABEL = Object.fromEntries(
    Object.entries(DEPARTMENT_LABELS).map(([key, label]) => [label, key])
);
let migratedLegacyData = false;

function makeEmptyState() {
    return { version: 2, sessions: {}, totals: {}, records: [], audit: [] };
}

function migrateLegacyState(legacy) {
    const state = makeEmptyState();

    for (const [oldKey, session] of Object.entries(legacy.sessions ?? {})) {
        const [guildId, userId] = oldKey.split(':');
        const department = DEPARTMENT_KEYS_BY_LABEL[session.department] ?? session.department;
        state.sessions[`${guildId}:${userId}`] = { ...session, department };
    }

    for (const [oldKey, totalMs] of Object.entries(legacy.totals ?? {})) {
        state.totals[`${oldKey}:legacy`] = totalMs;
    }

    return state;
}

function loadState() {
    try {
        const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (loaded.version === 1) {
            migratedLegacyData = true;
            return migrateLegacyState(loaded);
        }
        if (
            loaded.version !== 2 ||
            !loaded.sessions ||
            !loaded.totals ||
            !Array.isArray(loaded.records) ||
            !Array.isArray(loaded.audit)
        ) {
            throw new Error('Unsupported or invalid session data format.');
        }
        return loaded;
    } catch (error) {
        if (error.code === 'ENOENT') return makeEmptyState();
        throw error;
    }
}

let state = loadState();
if (migratedLegacyData) saveState();

function getUserKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getTotalKey(guildId, userId, department) {
    return `${getUserKey(guildId, userId)}:${department}`;
}

function isGuildUserKey(key, guildId) {
    return key.startsWith(`${guildId}:`);
}

function saveState() {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function persistMutation(mutate, rollback) {
    mutate();
    try {
        saveState();
    } catch (error) {
        rollback();
        throw error;
    }
}

function appendAudit({ guildId, userId = null, department = null, action, amountMs = null, actorId, details = '' }) {
    state.audit.push({
        id: randomUUID(),
        guildId,
        userId,
        department,
        action,
        amountMs,
        actorId,
        details,
        createdAt: Date.now()
    });
}

function recordAction({ guildId, userId = null, department = null, action, amountMs = null, actorId, details = '' }) {
    const auditLength = state.audit.length;
    persistMutation(
        () => appendAudit({ guildId, userId, department, action, amountMs, actorId, details }),
        () => { state.audit.length = auditLength; }
    );
}

function getSession(guildId, userId) {
    return state.sessions[getUserKey(guildId, userId)] ?? null;
}

function getSessions(guildId, department = null) {
    return Object.entries(state.sessions)
        .filter(([key, session]) => isGuildUserKey(key, guildId) && (!department || session.department === department))
        .map(([key, session]) => ({
            guildId,
            userId: key.slice(`${guildId}:`.length),
            ...session
        }));
}

function getDepartmentTotals(guildId, department = null) {
    return Object.entries(state.totals)
        .filter(([key]) => isGuildUserKey(key, guildId))
        .map(([key, totalMs]) => {
            const [userId, departmentKey] = key.slice(`${guildId}:`.length).split(':');
            return { userId, department: departmentKey, totalMs };
        })
        .filter(row => !department || row.department === department);
}

function getRecords(guildId, department = null) {
    return state.records.filter(record =>
        record.guildId === guildId && (!department || record.department === department)
    );
}

function getAuditEvents(guildId, department = null) {
    return state.audit.filter(event =>
        event.guildId === guildId &&
        (!department || event.department === department || event.department === 'all')
    );
}

function getUserState(guildId, userId) {
    const prefix = `${getUserKey(guildId, userId)}:`;
    const totalMs = Object.entries(state.totals)
        .filter(([key]) => key.startsWith(prefix))
        .reduce((sum, [, value]) => sum + value, 0);
    return { session: getSession(guildId, userId), totalMs };
}

function startSession(guildId, userId, department) {
    const key = getUserKey(guildId, userId);
    if (state.sessions[key]) throw new Error('User already has an active session.');

    const session = { startTime: Date.now(), department };
    const auditLength = state.audit.length;
    persistMutation(
        () => {
            state.sessions[key] = session;
            appendAudit({ guildId, userId, department, action: 'login', actorId: userId });
        },
        () => {
            delete state.sessions[key];
            state.audit.length = auditLength;
        }
    );
    return session;
}

function finishSession(guildId, userId, { actorId = userId, forced = false } = {}) {
    const key = getUserKey(guildId, userId);
    const session = state.sessions[key];
    if (!session) return null;

    const durationMs = Math.max(0, Date.now() - session.startTime);
    const totalKey = getTotalKey(guildId, userId, session.department);
    const previousTotal = state.totals[totalKey];
    const totalMs = (previousTotal ?? 0) + durationMs;
    const record = {
        id: randomUUID(),
        guildId,
        userId,
        department: session.department,
        startTime: session.startTime,
        endTime: Date.now(),
        durationMs,
        forced,
        actorId
    };
    const recordsLength = state.records.length;
    const auditLength = state.audit.length;

    persistMutation(
        () => {
            state.totals[totalKey] = totalMs;
            delete state.sessions[key];
            state.records.push(record);
            appendAudit({
                guildId,
                userId,
                department: session.department,
                action: forced ? 'forced_logout' : 'logout',
                amountMs: durationMs,
                actorId
            });
        },
        () => {
            state.sessions[key] = session;
            if (previousTotal === undefined) delete state.totals[totalKey];
            else state.totals[totalKey] = previousTotal;
            state.records.length = recordsLength;
            state.audit.length = auditLength;
        }
    );

    return { ...session, durationMs, totalMs, record };
}

function cancelSession(guildId, userId, { actorId = userId, action = 'clear_session' } = {}) {
    const key = getUserKey(guildId, userId);
    const session = state.sessions[key];
    if (!session) return null;
    const auditLength = state.audit.length;

    persistMutation(
        () => {
            delete state.sessions[key];
            appendAudit({ guildId, userId, department: session.department, action, actorId });
        },
        () => {
            state.sessions[key] = session;
            state.audit.length = auditLength;
        }
    );
    return session;
}

function adjustTime(guildId, userId, department, deltaMs, { actorId, action }) {
    const key = getTotalKey(guildId, userId, department);
    const previousTotal = state.totals[key];
    const totalMs = (previousTotal ?? 0) + deltaMs;
    if (totalMs < 0) return { ok: false, totalMs: previousTotal ?? 0 };
    const auditLength = state.audit.length;

    persistMutation(
        () => {
            state.totals[key] = totalMs;
            appendAudit({ guildId, userId, department, action, amountMs: deltaMs, actorId });
        },
        () => {
            if (previousTotal === undefined) delete state.totals[key];
            else state.totals[key] = previousTotal;
            state.audit.length = auditLength;
        }
    );
    return { ok: true, totalMs };
}

function adjustMinutes(guildId, userId, minutes) {
    return adjustTime(guildId, userId, 'legacy', minutes * 60 * 1000, {
        actorId: 'legacy',
        action: 'legacy_adjustment'
    });
}

function resetUser(guildId, userId) {
    const prefix = `${getUserKey(guildId, userId)}:`;
    const previousTotals = Object.fromEntries(Object.entries(state.totals).filter(([key]) => key.startsWith(prefix)));
    const previousSession = state.sessions[getUserKey(guildId, userId)];
    const previousAudit = state.audit;

    persistMutation(
        () => {
            for (const key of Object.keys(previousTotals)) delete state.totals[key];
            delete state.sessions[getUserKey(guildId, userId)];
            state.audit = state.audit.filter(event => !(event.guildId === guildId && event.userId === userId));
        },
        () => {
            Object.assign(state.totals, previousTotals);
            if (previousSession) state.sessions[getUserKey(guildId, userId)] = previousSession;
            state.audit = previousAudit;
        }
    );
}

function resetDepartment(guildId, department, actorId) {
    const previousSessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([key, session]) =>
            isGuildUserKey(key, guildId) && session.department === department
        )
    );
    const previousTotals = Object.fromEntries(
        Object.entries(state.totals).filter(([key]) =>
            key.endsWith(`:${department}`) && isGuildUserKey(key, guildId)
        )
    );
    const previousRecords = state.records;
    const previousAudit = state.audit;

    persistMutation(
        () => {
            for (const key of Object.keys(previousSessions)) delete state.sessions[key];
            for (const key of Object.keys(previousTotals)) delete state.totals[key];
            state.records = state.records.filter(record => record.guildId !== guildId || record.department !== department);
            state.audit = state.audit.filter(event => event.guildId !== guildId || event.department !== department);
            appendAudit({ guildId, department, action: 'reset_department', actorId });
        },
        () => {
            Object.assign(state.sessions, previousSessions);
            Object.assign(state.totals, previousTotals);
            state.records = previousRecords;
            state.audit = previousAudit;
        }
    );
    return { sessions: Object.keys(previousSessions).length, totals: Object.keys(previousTotals).length };
}

function resetGuild(guildId, actorId) {
    const previousSessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([key]) => isGuildUserKey(key, guildId))
    );
    const previousTotals = Object.fromEntries(
        Object.entries(state.totals).filter(([key]) => isGuildUserKey(key, guildId))
    );
    const previousRecords = state.records;
    const previousAudit = state.audit;

    persistMutation(
        () => {
            for (const key of Object.keys(previousSessions)) delete state.sessions[key];
            for (const key of Object.keys(previousTotals)) delete state.totals[key];
            state.records = state.records.filter(record => record.guildId !== guildId);
            state.audit = state.audit.filter(event => event.guildId !== guildId);
            appendAudit({ guildId, department: 'all', action: 'reset_all', actorId });
        },
        () => {
            Object.assign(state.sessions, previousSessions);
            Object.assign(state.totals, previousTotals);
            state.records = previousRecords;
            state.audit = previousAudit;
        }
    );
    return { sessions: Object.keys(previousSessions).length, totals: Object.keys(previousTotals).length };
}

module.exports = {
    adjustMinutes,
    adjustTime,
    cancelSession,
    finishSession,
    getActiveSessions: getSessions,
    getAuditEvents,
    getDepartmentTotals,
    getRecords,
    getSession,
    getUserState,
    recordAction,
    resetDepartment,
    resetGuild,
    resetUser,
    startSession
};
