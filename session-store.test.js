const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'my-bot-test-'));
process.env.BOT_DATA_PATH = path.join(directory, 'sessions.json');
const store = require('./session-store');

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('sessions and balances persist and remain scoped to a guild', () => {
    const first = store.startSession('guild-a', 'user-a', 'قبول توظيف');
    assert.equal(store.getSession('guild-a', 'user-a').department, first.department);
    assert.equal(store.getSession('guild-b', 'user-a'), null);

    const ended = store.finishSession('guild-a', 'user-a');
    assert.ok(ended.durationMs >= 0);
    assert.equal(store.getUserState('guild-a', 'user-a').totalMs, ended.durationMs);
    assert.equal(store.getUserState('guild-b', 'user-a').totalMs, 0);
});

test('admin balance adjustments reject negative balances and reset sessions', () => {
    assert.equal(store.adjustMinutes('guild-a', 'user-b', -1).ok, false);
    assert.equal(store.adjustMinutes('guild-a', 'user-b', 10).totalMs, 600000);
    assert.equal(store.adjustMinutes('guild-a', 'user-b', -3).totalMs, 420000);

    store.startSession('guild-a', 'user-b', 'مركز عمليات');
    store.resetUser('guild-a', 'user-b');
    assert.equal(store.getUserState('guild-a', 'user-b').totalMs, 0);
    assert.equal(store.getSession('guild-a', 'user-b'), null);
});

test('a session can be cleared without adding time to the balance', () => {
    store.startSession('guild-a', 'user-c', 'شؤون داخلية');
    assert.equal(store.cancelSession('guild-a', 'user-c').department, 'شؤون داخلية');
    assert.equal(store.getSession('guild-a', 'user-c'), null);
    assert.equal(store.getUserState('guild-a', 'user-c').totalMs, 0);
    assert.equal(store.cancelSession('guild-a', 'user-c'), null);
});

test('completed and cleared sessions are audited differently', () => {
    store.startSession('guild-a', 'user-d', 'acceptance');
    const cleared = store.cancelSession('guild-a', 'user-d', {
        actorId: 'manager',
        action: 'clear_session'
    });
    assert.equal(cleared.department, 'acceptance');
    assert.equal(store.getDepartmentTotals('guild-a', 'acceptance')
        .some(row => row.userId === 'user-d'), false);

    store.startSession('guild-a', 'user-d', 'acceptance');
    const ended = store.finishSession('guild-a', 'user-d', { actorId: 'manager', forced: true });
    assert.ok(ended.durationMs >= 0);
    assert.equal(ended.totalMs, ended.durationMs);
    assert.equal(store.getRecords('guild-a', 'acceptance').at(-1).forced, true);
    assert.equal(store.getAuditEvents('guild-a', 'acceptance').at(-1).action, 'forced_logout');
});

test('department reset removes its balances, sessions, and history only', () => {
    store.adjustTime('guild-a', 'user-e', 'acceptance', 3600000, {
        actorId: 'manager',
        action: 'add_time'
    });
    store.adjustTime('guild-a', 'user-e', 'operations', 120000, {
        actorId: 'manager',
        action: 'add_time'
    });
    store.startSession('guild-a', 'user-f', 'acceptance');
    store.startSession('guild-a', 'user-g', 'operations');

    const reset = store.resetDepartment('guild-a', 'acceptance', 'manager');
    assert.equal(reset.sessions, 1);
    assert.equal(store.getSession('guild-a', 'user-f'), null);
    assert.equal(store.getSession('guild-a', 'user-g').department, 'operations');
    assert.equal(store.getDepartmentTotals('guild-a', 'acceptance').length, 0);
    assert.equal(store.getDepartmentTotals('guild-a', 'operations')
        .find(row => row.userId === 'user-e').totalMs, 120000);
    assert.equal(store.getRecords('guild-a', 'acceptance').length, 0);
    assert.equal(store.getAuditEvents('guild-a', 'acceptance').at(-1).action, 'reset_department');
});

test('guild reset clears all users and keeps other guilds untouched', () => {
    store.adjustTime('guild-a', 'user-h', 'operations', 60000, {
        actorId: 'manager',
        action: 'add_time'
    });
    store.adjustTime('guild-b', 'user-h', 'operations', 120000, {
        actorId: 'manager',
        action: 'add_time'
    });

    const reset = store.resetGuild('guild-a', 'manager');
    assert.ok(reset.totals > 0);
    assert.equal(store.getDepartmentTotals('guild-a').length, 0);
    assert.equal(store.getRecords('guild-a').length, 0);
    assert.deepEqual(store.getAuditEvents('guild-a').map(event => event.action), ['reset_all']);
    assert.equal(store.getDepartmentTotals('guild-b', 'operations')
        .find(row => row.userId === 'user-h').totalMs, 120000);
});

test('legacy v1 balances and active sessions are migrated without loss', () => {
    const legacyPath = path.join(directory, 'legacy.json');
    fs.writeFileSync(legacyPath, JSON.stringify({
        version: 1,
        sessions: {
            'guild-old:user-old': { startTime: 123, department: 'قبول توظيف' }
        },
        totals: { 'guild-old:user-old': 90000 }
    }));
    const storePath = path.join(__dirname, 'session-store.js');
    const script = `
        const store = require(${JSON.stringify(storePath)});
        const result = {
            session: store.getSession('guild-old', 'user-old'),
            total: store.getDepartmentTotals('guild-old')[0]
        };
        console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, BOT_DATA_PATH: legacyPath }
    });

    assert.equal(child.status, 0, child.stderr);
    const migrated = JSON.parse(child.stdout.trim());
    assert.equal(migrated.session.department, 'acceptance');
    assert.equal(migrated.total.department, 'legacy');
    assert.equal(migrated.total.totalMs, 90000);
    assert.equal(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).version, 2);
});

test('state is written to disk', () => {
    const stored = JSON.parse(fs.readFileSync(process.env.BOT_DATA_PATH, 'utf8'));
    assert.equal(stored.version, 2);
    assert.ok(Array.isArray(stored.records));
    assert.ok(Array.isArray(stored.audit));
});
