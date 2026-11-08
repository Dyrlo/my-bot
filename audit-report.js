function buildAuditSummaryRows({ totals, records, sessions, getDepartmentLabel, getDisplayName }) {
    const users = new Map();
    const getUser = (userId, department) => {
        let user = users.get(userId);
        if (!user) {
            user = { userId, totalMs: 0, completedSessions: 0, departments: new Set() };
            users.set(userId, user);
        }
        if (department) user.departments.add(getDepartmentLabel(department));
        return user;
    };

    for (const total of totals) {
        getUser(total.userId, total.department).totalMs += total.totalMs;
    }
    for (const record of records) {
        getUser(record.userId, record.department).completedSessions += 1;
    }
    for (const session of sessions) {
        getUser(session.userId, session.department);
    }

    return [...users.values()]
        .map(user => ({ ...user, displayName: getDisplayName(user.userId) }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ar') || a.userId.localeCompare(b.userId))
        .map(user => {
            const hours = Math.floor(user.totalMs / (60 * 60 * 1000));
            const minutes = Math.floor((user.totalMs % (60 * 60 * 1000)) / (60 * 1000));
            const departments = [...user.departments].sort((a, b) => a.localeCompare(b, 'ar')).join('، ') || 'غير مصنف';
            return {
                name: `👤 ${user.displayName || 'مسؤول'}`,
                value: `العضو: <@${user.userId}>\nالقسم: ${departments}\nإجمالي الساعات: ${hours} ساعة، ${minutes} دقيقة\nالجلسات المكتملة: ${user.completedSessions}`,
                inline: false
            };
        });
}

module.exports = { buildAuditSummaryRows };
