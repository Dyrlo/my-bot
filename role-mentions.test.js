const assert = require('node:assert/strict');
const test = require('node:test');
const { chunkUserIds, formatRoleMentionMessage, hasAllowedRole } = require('./role-mentions');

test('role mentions are chunked without losing or duplicating user IDs', () => {
    const userIds = Array.from({ length: 95 }, (_, index) => `user-${index}`);
    const chunks = chunkUserIds(userIds);

    assert.deepEqual(chunks.map(chunk => chunk.length), [40, 40, 15]);
    assert.deepEqual(chunks.flat(), userIds);
});

test('only members with either authorized role can use role mentions', () => {
    const allowedRoles = ['allowed-a', 'allowed-b'];

    assert.equal(hasAllowedRole(['other-role', 'allowed-a'], allowedRoles), true);
    assert.equal(hasAllowedRole(['allowed-b'], allowedRoles), true);
    assert.equal(hasAllowedRole(['other-role'], allowedRoles), false);
});

test('role member list is numbered sequentially and includes no broadcast text', () => {
    assert.equal(
        formatRoleMentionMessage(['111111111111111111', '222222222222222222'], 4),
        'أعضاء مركز عمليات\n-5 <@111111111111111111>\n-6 <@222222222222222222>'
    );
});
