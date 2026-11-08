function chunkUserIds(userIds, maxUsersPerMessage = 40) {
    const chunks = [];
    for (let offset = 0; offset < userIds.length; offset += maxUsersPerMessage) {
        chunks.push(userIds.slice(offset, offset + maxUsersPerMessage));
    }
    return chunks;
}

function hasAllowedRole(roleIds, allowedRoleIds) {
    return allowedRoleIds.some(roleId => roleIds.includes(roleId));
}

function formatRoleMentionMessage(userIds, startIndex = 0) {
    return [
        'أعضاء مركز عمليات',
        ...userIds.map((userId, index) => `-${startIndex + index + 1} <@${userId}>`)
    ].join('\n');
}

module.exports = { chunkUserIds, formatRoleMentionMessage, hasAllowedRole };
