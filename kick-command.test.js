const assert = require('node:assert/strict');
const test = require('node:test');
const { hasMinimumRole, parseKickCommand } = require('./kick-command');

test('kick command accepts one numeric Discord user ID', () => {
    assert.deepEqual(parseKickCommand('طرد 123456789012345678'), {
        userId: '123456789012345678'
    });
});

test('kick command rejects missing, malformed, or extra arguments', () => {
    assert.deepEqual(parseKickCommand('طرد'), { userId: null });
    assert.deepEqual(parseKickCommand('طرد not-an-id'), { userId: null });
    assert.deepEqual(parseKickCommand('طرد 123456789012345678 extra'), { userId: null });
    assert.equal(parseKickCommand('دخول'), null);
});

test('members at or above the required role hierarchy qualify', () => {
    const minimumRole = { position: 5 };
    const member = position => ({
        roles: {
            highest: {
                comparePositionTo: role => position - role.position
            }
        }
    });

    assert.equal(hasMinimumRole(member(5), minimumRole), true);
    assert.equal(hasMinimumRole(member(8), minimumRole), true);
    assert.equal(hasMinimumRole(member(4), minimumRole), false);
});
