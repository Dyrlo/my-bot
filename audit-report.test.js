const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAuditSummaryRows } = require('./audit-report');

test('audit summary aggregates all departments once per user', () => {
    const rows = buildAuditSummaryRows({
        totals: [
            { userId: '111111111111111111', department: 'acceptance', totalMs: 2 * 60 * 60 * 1000 + 30 * 60 * 1000 },
            { userId: '111111111111111111', department: 'operations', totalMs: 45 * 60 * 1000 }
        ],
        records: [
            { userId: '111111111111111111', department: 'acceptance' },
            { userId: '111111111111111111', department: 'acceptance' },
            { userId: '111111111111111111', department: 'operations' }
        ],
        sessions: [{ userId: '222222222222222222', department: 'internal_affairs', startTime: 0 }],
        getDepartmentLabel: department => ({
            acceptance: 'قبول توظيف',
            operations: 'مركز العمليات',
            internal_affairs: 'شؤون داخلية'
        })[department],
        getDisplayName: userId => userId === '111111111111111111' ? 'المسؤول أ' : 'المسؤول ب'
    });

    assert.deepEqual(rows, [
        {
            name: '👤 المسؤول أ',
            value: 'العضو: <@111111111111111111>\nالقسم: قبول توظيف، مركز العمليات\nإجمالي الساعات: 3 ساعة، 15 دقيقة\nالجلسات المكتملة: 3',
            inline: false
        },
        {
            name: '👤 المسؤول ب',
            value: 'العضو: <@222222222222222222>\nالقسم: شؤون داخلية\nإجمالي الساعات: 0 ساعة، 0 دقيقة\nالجلسات المكتملة: 0',
            inline: false
        }
    ]);
});
