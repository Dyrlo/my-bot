function parseKickCommand(content) {
    const parts = content.trim().split(/\s+/);
    if (parts[0] !== 'طرد') return null;
    if (parts.length !== 2 || !/^\d{17,20}$/.test(parts[1])) return { userId: null };
    return { userId: parts[1] };
}

function hasMinimumRole(member, minimumRole) {
    return member.roles.highest.comparePositionTo(minimumRole) >= 0;
}

module.exports = { hasMinimumRole, parseKickCommand };
