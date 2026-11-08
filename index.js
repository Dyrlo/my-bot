require('dotenv').config();

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    MessageFlags,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
    StringSelectMenuBuilder
} = require('discord.js');
const store = require('./session-store');
const { buildAuditSummaryRows } = require('./audit-report');
const { hasMinimumRole, parseKickCommand } = require('./kick-command');
const { chunkUserIds, formatRoleMentionMessage, hasAllowedRole } = require('./role-mentions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = '1526267206135185630';
const MANAGER_ROLE_ID = '1564927349919588393';
const OPERATIONS_MANAGER_ROLE_ID = '1556552389446737970';
const EXPELLED_MEMBERS_CHANNEL_ID = '1566031854338056303';
const TEXT_ATTENDANCE_CHANNEL_ID = '1556768144171737198';
const ROLE_MANAGEMENT_CHANNEL_ID = '1568387090851438772';
const ROLE_PING_TARGET_ID = '1556531003416379402';
const ROLE_PING_ALLOWED_ROLE_IDS = [
    '1556552357171560508',
    '1556552384820412436'
];
const ALLOWED_CHANNEL_IDS = new Set([
    '1568312683218862180',
    '1568310794251141240'
]);

const DEPARTMENTS = [
    { label: 'Dy مسؤول قبول وتوظيف', value: 'acceptance', id: '1526269093370663124' },
    { label: 'Dy19 مسؤول مركز عمليات', value: 'operations', id: '1556552389446737970' },
    { label: 'Dy194 أعضاء شؤون داخلية', value: 'internal_affairs', id: '1526267885528289412' }
];

const MANAGEABLE_ROLES = {
    operations_and_security: [
        { id: '1556531003416379402', label: 'مركز العمليات' },
        { id: '1527251569307811901', label: 'الأمن العام' },
        { id: '1556521641872334948', label: 'تحت الاختبار' }
    ],
    functional_warning_1: [{ id: '1526271084142264561', label: 'إنذار وظيفي أول' }],
    functional_warning_2: [{ id: '1526271106275868793', label: 'إنذار وظيفي ثاني' }],
    verbal_warning_1: [{ id: '1556516963453247538', label: 'إنذار شفوي أول' }],
    verbal_warning_2: [{ id: '1556517897596182589', label: 'إنذار شفوي ثاني' }],
    permanent_warning: [{ id: '1556515656201928744', label: 'إنذار دائم' }]
};
const ALL_MANAGEABLE_ROLES = Object.values(MANAGEABLE_ROLES).flat();

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${hours} ساعة, ${minutes} دقيقة, ${remainingSeconds} ثانية`;
}

function hasRole(member, roleId) {
    return member?.roles?.cache?.has(roleId) ?? member?.roles?.includes(roleId) ?? false;
}

function findDepartment(value) {
    return DEPARTMENTS.find(department => department.value === value || department.label === value) ?? null;
}

function hasAdminPermissions(member) {
    if (hasRole(member, MANAGER_ROLE_ID)) return true;
    const permissions = member?.permissions;
    if (permissions?.has) return permissions.has(PermissionFlagsBits.Administrator);
    if (typeof permissions === 'string' || typeof permissions === 'number' || typeof permissions === 'bigint') {
        return (BigInt(permissions) & BigInt(PermissionFlagsBits.Administrator)) !== 0n;
    }
    return false;
}

function buildCommands() {
    const departmentChoices = DEPARTMENTS.map(({ label, value }) => ({ name: label, value }));
    return [
        new SlashCommandBuilder()
            .setName('login')
            .setDescription('تسجيل الدخول واختيار القسم')
            .setDefaultMemberPermissions(null),
        new SlashCommandBuilder()
            .setName('logout')
            .setDescription('تسجيل الخروج وحساب مدة الجلسة')
            .setDefaultMemberPermissions(null),
        new SlashCommandBuilder()
            .setName('manage-roles')
            .setDescription('إضافة أو سحب الرتب المحددة لمسؤول')
            .setDefaultMemberPermissions(null)
            .addStringOption(option => option
                .setName('action')
                .setDescription('العملية والرتبة المطلوبة')
                .setRequired(true)
                .addChoices(
                    { name: 'إعطاء: مركز العمليات + الأمن العام', value: 'grant:operations_and_security' },
                    { name: 'سحب: مركز العمليات + الأمن العام', value: 'remove:operations_and_security' },
                    { name: 'إعطاء: إنذار وظيفي أول', value: 'grant:functional_warning_1' },
                    { name: 'سحب: إنذار وظيفي أول', value: 'remove:functional_warning_1' },
                    { name: 'إعطاء: إنذار وظيفي ثاني', value: 'grant:functional_warning_2' },
                    { name: 'سحب: إنذار وظيفي ثاني', value: 'remove:functional_warning_2' },
                    { name: 'إعطاء: إنذار شفوي أول', value: 'grant:verbal_warning_1' },
                    { name: 'سحب: إنذار شفوي أول', value: 'remove:verbal_warning_1' },
                    { name: 'إعطاء: إنذار شفوي ثاني', value: 'grant:verbal_warning_2' },
                    { name: 'سحب: إنذار شفوي ثاني', value: 'remove:verbal_warning_2' },
                    { name: 'إعطاء: إنذار دائم', value: 'grant:permanent_warning' },
                    { name: 'سحب: إنذار دائم', value: 'remove:permanent_warning' },
                    { name: 'سحب جميع الرتب المذكورة', value: 'remove:all_listed' }
                ))
            .addUserOption(option => option
                .setName('target')
                .setDescription('العضو المستهدف')
                .setRequired(true)),
        new SlashCommandBuilder()
            .setName('admin')
            .setDescription('إدارة الحضور والأرصدة')
            .setDefaultMemberPermissions(null)
            .addStringOption(option => option
                .setName('action')
                .setDescription('اختر الإجراء الإداري')
                .setRequired(true)
                .addChoices(
                    { name: '🚪 تسجيل خروج إجباري', value: 'forced_logout' },
                    { name: '🗑️ حذف جلسة دون احتساب الوقت', value: 'clear_session' },
                    { name: '➕ إضافة وقت', value: 'add_time' },
                    { name: '➖ خصم وقت', value: 'deduct_time' },
                    { name: '🔄 تصفير البيانات', value: 'reset_stats' },
                    { name: '👥 عرض المسجلين حاليًا', value: 'active_staff' },
                    { name: '📋 تقرير الجرد', value: 'audit_report' }
                ))
            .addStringOption(option => option
                .setName('department')
                .setDescription('القسم المستهدف')
                .addChoices(...departmentChoices))
            .addUserOption(option => option
                .setName('user')
                .setDescription('المسؤول المستهدف'))
            .addIntegerOption(option => option
                .setName('amount')
                .setDescription('مقدار الوقت بالساعات أو الدقائق')
                .setMinValue(1)
                .setMaxValue(100000))
            .addStringOption(option => option
                .setName('unit')
                .setDescription('وحدة الوقت')
                .addChoices(
                    { name: 'دقائق', value: 'minutes' },
                    { name: 'ساعات', value: 'hours' }
                ))
            .addStringOption(option => option
                .setName('scope')
                .setDescription('نطاق التصفير')
                .addChoices(
                    { name: 'قسم محدد', value: 'department' },
                    { name: 'جميع الأقسام والمسؤولين', value: 'all' }
                )),
        new SlashCommandBuilder()
            .setName('mention-role')
            .setDescription('إرسال منشن لجميع أعضاء رتبة مركز العمليات بعد التأكيد')
            .setDefaultMemberPermissions(null)
    ].map(command => command.toJSON());
}

async function registerCommands() {
    if (!CLIENT_ID) {
        throw new Error('Set CLIENT_ID in the environment.');
    }
    if (client.user.id !== CLIENT_ID) {
        throw new Error(`CLIENT_ID does not match the authenticated bot application (${client.user.id}).`);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = buildCommands();

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
    );
    console.log(`Cleared Global Commands and setup Guild Commands successfully`);
}

async function handleLogin(interaction) {
    if (store.getSession(interaction.guildId, interaction.user.id)) {
        return interaction.editReply('❌ أنت مسجل دخول بالفعل. سجّل الخروج أولًا قبل بدء جلسة أخرى.');
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`department_select:${interaction.user.id}`)
        .setPlaceholder('اختر القسم المطلوب')
        .addOptions(DEPARTMENTS.map(({ label, value }) => ({ label, value })));

    await interaction.channel.send({
        content: 'اختر القسم المطلوب. سيتم التحقق من رتبتك قبل تسجيل الدخول.',
        components: [new ActionRowBuilder().addComponents(menu)]
    });
    return interaction.editReply('✅ تم إرسال قائمة اختيار القسم إلى القناة.');
}

async function handleLogout(interaction) {
    if (!store.getSession(interaction.guildId, interaction.user.id)) {
        return interaction.editReply('ليس لديك جلسة نشطة حاليًا.');
    }

    const endedSession = store.finishSession(interaction.guildId, interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ تم تسجيل الخروج بنجاح')
        .addFields(
            { name: 'القسم', value: findDepartment(endedSession.department)?.label ?? endedSession.department, inline: true },
            { name: 'مدة الجلسة', value: formatDuration(endedSession.durationMs), inline: true },
            { name: 'إجمالي الرصيد', value: formatDuration(endedSession.totalMs), inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function handleTextAttendance(message) {
    if (
        message.author.bot ||
        !message.guild ||
        message.channelId !== TEXT_ATTENDANCE_CHANNEL_ID
    ) {
        return;
    }

    const command = message.content.trim();
    if (command !== 'دخول' && command !== 'خروج') return;

    try {
        const responseText = command === 'دخول'
            ? `✅ <@${message.author.id}> استلم الخدمة. يرجى التواجد في تردد مركز العمليات واستلام التوجيه.`
            : `✅ <@${message.author.id}> تم تسجيل خروجه بنجاح.`;
        const response = await message.channel.send(responseText);
        await response.react('✅');
    } catch (error) {
        console.error(`Text attendance command failed (${message.id}):`, error);
        await message.channel.send('❌ حدث خطأ أثناء إرسال الرسالة. حاول مرة أخرى أو أبلغ المدير.');
    }
}

async function sendKickCommandResponse(message, content) {
    try {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
    } catch (error) {
        console.error(`Could not respond to kick command (${message.id}):`, error);
    }
}

async function handleKickCommand(message) {
    if (
        message.author.bot ||
        !message.guild ||
        message.guild.id !== GUILD_ID ||
        message.channelId !== EXPELLED_MEMBERS_CHANNEL_ID
    ) {
        return;
    }

    const command = parseKickCommand(message.content);
    if (!command) return;
    if (!command.userId) {
        return sendKickCommandResponse(message, '❌ استخدم الأمر بهذا الشكل: `طرد <معرّف العضو>`.');
    }

    const actor = message.member;
    if (!actor) {
        return sendKickCommandResponse(message, '❌ تعذر التحقق من صلاحياتك.');
    }

    let target;
    try {
        const minimumRole = await message.guild.roles.fetch(OPERATIONS_MANAGER_ROLE_ID);
        if (!minimumRole) {
            console.error(`Required kick role is missing (${OPERATIONS_MANAGER_ROLE_ID}).`);
            return sendKickCommandResponse(message, '❌ رتبة مسؤول مركز العمليات غير موجودة؛ أبلغ المدير.');
        }
        if (!hasMinimumRole(actor, minimumRole)) {
            return sendKickCommandResponse(message, '❌ هذا الأمر مخصص لمسؤول مركز العمليات وما فوق.');
        }

        if (actor.id === command.userId) {
            return sendKickCommandResponse(message, '❌ لا يمكنك طرد نفسك.');
        }

        target = await message.guild.members.fetch(command.userId);
        if (actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
            return sendKickCommandResponse(message, '❌ لا يمكنك طرد عضو رتبته مساوية لرتبتك أو أعلى منها.');
        }

        const botMember = await message.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
            return sendKickCommandResponse(message, '❌ يحتاج البوت إلى صلاحية Kick Members لطرد الأعضاء.');
        }
        if (!target.kickable) {
            return sendKickCommandResponse(message, '❌ لا يستطيع البوت طرد هذا العضو. تحقق من ترتيب رتب البوت وصلاحياته.');
        }

        await target.kick(`Requested by ${actor.user.tag} (${actor.id}) in the expelled-members channel`);
    } catch (error) {
        console.error(`Kick command failed (${message.id}, target ${command.userId}):`, error);
        const response = error.code === 10007
            ? '❌ لم يتم العثور على هذا العضو في السيرفر. تأكد من صحة المعرّف.'
            : '❌ تعذر تنفيذ الطرد. تحقق من سجل البوت وصلاحياته.';
        return sendKickCommandResponse(message, response);
    }

    return sendKickCommandResponse(message, `✅ تم طرد <@${target.id}> من السيرفر.`);
}

function splitMessage(lines, maxLength = 1850) {
    const chunks = [];
    let chunk = '';
    for (const originalLine of lines) {
        const lineParts = [];
        for (let offset = 0; offset < originalLine.length; offset += maxLength) {
            lineParts.push(originalLine.slice(offset, offset + maxLength));
        }
        for (const line of lineParts) {
            if (chunk && chunk.length + line.length + 1 > maxLength) {
                chunks.push(chunk);
                chunk = line;
            } else {
                chunk = chunk ? `${chunk}\n${line}` : line;
            }
        }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}

async function replyWithLines(interaction, lines, emptyMessage) {
    const chunks = splitMessage(lines.length ? lines : [emptyMessage]);
    await interaction.editReply({ content: chunks[0] });
    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
}

async function handleForcedLogout(interaction) {
    const target = interaction.options.getUser('user', true);
    const session = store.getSession(interaction.guildId, target.id);
    if (!session) {
        return interaction.editReply(`❌ لا توجد جلسة نشطة للمسؤول <@${target.id}>.`);
    }

    const ended = store.finishSession(interaction.guildId, target.id, {
        actorId: interaction.user.id,
        forced: true
    });
    const department = findDepartment(session.department);

    return interaction.editReply(
        `✅ أُغلقت جلسة <@${target.id}> قسريًا دون تغيير رتب صلاحياته. القسم: **${department?.label ?? session.department}**، والمدة المحتسبة: **${formatDuration(ended.durationMs)}**.`
    );
}

async function handleClearSession(interaction) {
    const target = interaction.options.getUser('user', true);
    const cancelled = store.cancelSession(interaction.guildId, target.id, {
        actorId: interaction.user.id,
        action: 'clear_session'
    });
    if (!cancelled) {
        return interaction.editReply(`❌ لا توجد جلسة مسجلة للمسؤول <@${target.id}>.`);
    }

    const department = findDepartment(cancelled.department);
    return interaction.editReply(`✅ أُلغيت جلسة <@${target.id}> دون احتساب الوقت، ولم تتغير رتب صلاحياته${department ? ` (${department.label})` : ''}.`);
}

async function handleTimeAdjustment(interaction, action) {
    const target = interaction.options.getUser('user', true);
    const department = findDepartment(interaction.options.getString('department', true));
    const amount = interaction.options.getInteger('amount', true);
    const unit = interaction.options.getString('unit', true);
    const multiplier = unit === 'hours' ? 60 * 60 * 1000 : 60 * 1000;
    const deltaMs = amount * multiplier * (action === 'add_time' ? 1 : -1);
    const result = store.adjustTime(
        interaction.guildId,
        target.id,
        department.value,
        deltaMs,
        { actorId: interaction.user.id, action }
    );

    if (!result.ok) {
        return interaction.editReply(`❌ لا يمكن خصم وقت أكثر من رصيد <@${target.id}> في قسم **${department.label}**.`);
    }
    return interaction.editReply(
        `✅ تم ${action === 'add_time' ? 'إضافة' : 'خصم'} **${amount} ${unit === 'hours' ? 'ساعة' : 'دقيقة'}** لـ <@${target.id}> في **${department.label}**. الرصيد الجديد: **${formatDuration(result.totalMs)}**.`
    );
}

async function handleResetStats(interaction) {
    const scope = interaction.options.getString('scope', true);
    const departmentValue = interaction.options.getString('department');
    if (scope === 'department' && !departmentValue) {
        return interaction.editReply('❌ اختر القسم الذي تريد تصفيره.');
    }
    if (scope === 'all' && departmentValue) {
        return interaction.editReply('❌ لا تحدد قسمًا عند اختيار تصفير جميع الأقسام.');
    }

    const department = departmentValue ? findDepartment(departmentValue) : null;
    if (scope === 'department' && !department) {
        return interaction.editReply('❌ القسم المحدد غير معروف.');
    }

    const result = scope === 'department'
        ? store.resetDepartment(interaction.guildId, department.value, interaction.user.id)
        : store.resetGuild(interaction.guildId, interaction.user.id);

    const label = department ? `قسم **${department.label}**` : '**جميع الأقسام والمسؤولين**';
    return interaction.editReply(
        `✅ تم تصفير ${label} وحذف سجلاته وإنهاء ${result.sessions} جلسة نشطة. لم يتم تغيير رتب صلاحيات الأقسام.`
    );
}

async function handleActiveStaff(interaction) {
    const departmentValue = interaction.options.getString('department');
    const sessions = store.getActiveSessions(interaction.guildId, departmentValue);
    const lines = sessions.map(session => {
        const department = findDepartment(session.department);
        const elapsed = Math.max(0, Date.now() - session.startTime);
        return `• <@${session.userId}> — **${department?.label ?? session.department}** — ${formatDuration(elapsed)}`;
    });
    await replyWithLines(interaction, lines, 'لا يوجد مسؤولون مسجلون حاليًا في النطاق المحدد.');
}

async function handleAuditReport(interaction) {
    const departmentValue = interaction.options.getString('department');
    const rows = buildAuditSummaryRows({
        totals: store.getDepartmentTotals(interaction.guildId, departmentValue),
        records: store.getRecords(interaction.guildId, departmentValue),
        sessions: store.getActiveSessions(interaction.guildId, departmentValue),
        getDepartmentLabel: department => findDepartment(department)?.label ??
            (department === 'legacy' ? 'رصيد سابق غير مصنف' : department),
        getDisplayName: userId => interaction.guild.members.cache.get(userId)?.displayName ?? `<@${userId}>`
    });
    const embeds = rows.length
        ? rows.map(row => new EmbedBuilder()
            .setColor(0x2b2d31)
            .setTitle(row.name)
            .setDescription(row.value))
        : [
            new EmbedBuilder()
                .setColor(0x2b2d31)
                .setTitle('📋 ملخص الحضور الإجمالي')
                .setDescription('لا توجد أرصدة أو جلسات في النطاق المحدد.')
        ];
    const embedChunks = [];
    for (let offset = 0; offset < embeds.length; offset += 10) {
        embedChunks.push(embeds.slice(offset, offset + 10));
    }

    await interaction.editReply({ embeds: embedChunks[0] });
    for (const chunk of embedChunks.slice(1)) {
        await interaction.followUp({
            embeds: chunk,
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleAdminCommand(interaction) {
    if (!hasAdminPermissions(interaction.member)) {
        return interaction.editReply('❌ هذا الأمر يتطلب رتبة المدير أو صلاحية Administrator.');
    }

    const action = interaction.options.getString('action', true);
    const requiredOptions = {
        forced_logout: ['user'],
        clear_session: ['user'],
        add_time: ['user', 'department', 'amount', 'unit'],
        deduct_time: ['user', 'department', 'amount', 'unit'],
        reset_stats: ['scope'],
        active_staff: [],
        audit_report: []
    }[action];

    if (!requiredOptions) {
        return interaction.editReply('❌ اختر إجراءً إداريًا صحيحًا.');
    }

    const missingOption = requiredOptions.find(optionName => {
        if (optionName === 'user') return !interaction.options.getUser(optionName);
        if (optionName === 'amount') return interaction.options.getInteger(optionName) === null;
        return !interaction.options.getString(optionName);
    });
    if (missingOption) {
        const optionLabels = {
            user: 'المسؤول',
            department: 'القسم',
            amount: 'المدة',
            unit: 'وحدة الوقت',
            scope: 'نطاق التصفير'
        };
        return interaction.editReply(`❌ اختر ${optionLabels[missingOption]} المطلوب لهذا الإجراء.`);
    }

    if (action === 'reset_stats' &&
        interaction.options.getString('scope') === 'department' &&
        !interaction.options.getString('department')) {
        return interaction.editReply('❌ اختر القسم الذي تريد تصفيره.');
    }

    switch (action) {
        case 'forced_logout':
            return handleForcedLogout(interaction);
        case 'clear_session':
            return handleClearSession(interaction);
        case 'add_time':
            return handleTimeAdjustment(interaction, 'add_time');
        case 'deduct_time':
            return handleTimeAdjustment(interaction, 'deduct_time');
        case 'reset_stats':
            return handleResetStats(interaction);
        case 'active_staff':
            return handleActiveStaff(interaction);
        case 'audit_report':
            return handleAuditReport(interaction);
        default:
            return interaction.editReply('❌ أمر الإدارة غير معروف.');
    }
}

function canUseRoleMention(member) {
    const roleIds = member?.roles?.cache
        ? [...member.roles.cache.keys()]
        : member?.roles ?? [];
    return hasAllowedRole(roleIds, ROLE_PING_ALLOWED_ROLE_IDS);
}

async function handleRoleMentionCommand(interaction) {
    if (!canUseRoleMention(interaction.member)) {
        return interaction.editReply('❌ لا تملك صلاحية استخدام أمر المنشن.');
    }

    const role = await interaction.guild.roles.fetch(ROLE_PING_TARGET_ID);
    if (!role) {
        return interaction.editReply('❌ الرتبة المستهدفة غير موجودة في هذا السيرفر.');
    }
    if (typeof interaction.channel?.send !== 'function') {
        return interaction.editReply('❌ لا يمكن إرسال المنشن في هذه القناة.');
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`role_ping:confirm:${interaction.user.id}`)
            .setLabel('تأكيد المنشن')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`role_ping:cancel:${interaction.user.id}`)
            .setLabel('إلغاء')
            .setStyle(ButtonStyle.Secondary)
    );

    return interaction.editReply({
        content: `سيتم إرسال تنبيه إلى جميع أعضاء رتبة **${role.name}** في هذه القناة. هل تريد المتابعة؟`,
        components: [row]
    });
}

async function handleRoleMentionConfirmation(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
        return interaction.reply({
            content: '❌ هذا التأكيد ليس لك.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (!interaction.inGuild()) {
        return interaction.reply({
            content: '❌ هذا الأمر متاح داخل السيرفر فقط.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (action === 'cancel') {
        return interaction.update({ content: 'تم إلغاء إرسال المنشن.', components: [] });
    }
    if (action !== 'confirm') {
        return interaction.reply({
            content: '❌ خيار التأكيد غير معروف.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (!canUseRoleMention(interaction.member)) {
        return interaction.update({ content: '❌ لا تملك صلاحية استخدام أمر المنشن.', components: [] });
    }
    if (typeof interaction.channel?.send !== 'function') {
        return interaction.update({ content: '❌ لا يمكن إرسال المنشن في هذه القناة.', components: [] });
    }

    await interaction.update({ content: '⏳ جارٍ تجهيز قائمة أعضاء الرتبة...', components: [] });

    let members;
    try {
        members = await interaction.guild.members.fetch();
    } catch (error) {
        console.error('Could not fetch guild members for role mention:', error);
        return interaction.editReply({
            content: '❌ تعذر جلب أعضاء السيرفر. تأكد من تفعيل Server Members Intent للبوت في Discord Developer Portal.',
            components: []
        });
    }

    const memberIds = members
        .filter(member => member.roles.cache.has(ROLE_PING_TARGET_ID))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ar') || a.id.localeCompare(b.id))
        .map(member => member.id);
    if (!memberIds.length) {
        return interaction.editReply({ content: 'لا يوجد أعضاء يحملون الرتبة المستهدفة.', components: [] });
    }

    const chunks = chunkUserIds(memberIds);
    let sent = 0;
    try {
        for (const [chunkIndex, chunk] of chunks.entries()) {
            await interaction.channel.send({
                content: formatRoleMentionMessage(chunk, chunkIndex * 40),
                allowedMentions: { parse: [] }
            });
            sent += chunk.length;
        }
    } catch (error) {
        console.error(`Role mention broadcast failed after ${sent}/${memberIds.length} members:`, error);
        return interaction.editReply({
            content: `❌ تعذر إكمال الإرسال. وصل التنبيه إلى ${sent} من ${memberIds.length} عضو؛ راجع صلاحيات البوت وسجل التشغيل.`,
            components: []
        });
    }

    return interaction.editReply({
        content: `✅ تم نشر قائمة أعضاء مركز العمليات (${sent} عضو) دون إرسال إشعارات لهم.`,
        components: []
    });
}

async function handleManageRoles(interaction) {
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasRole(actor, OPERATIONS_MANAGER_ROLE_ID)) {
        return interaction.editReply('❌ هذا الأمر مخصص لمسؤول مركز العمليات.');
    }

    if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply('❌ البوت يحتاج صلاحية Manage Roles لتنفيذ هذا الطلب.');
    }

    const targetUser = interaction.options.getUser('target', true);
    if (targetUser.id === interaction.user.id) {
        return interaction.editReply('❌ لا يمكنك استخدام هذا الأمر لإعطاء أو سحب الرتب من نفسك.');
    }

    const target = await interaction.guild.members.fetch(targetUser.id);
    if (target.roles.highest.comparePositionTo(actor.roles.highest) >= 0) {
        return interaction.editReply('❌ لا يمكنك تعديل رتب عضو رتبته مساوية لرتبتك أو أعلى منها.');
    }

    const action = interaction.options.getString('action', true);
    const [operation, roleGroup] = action.split(':');
    if (!['grant', 'remove'].includes(operation) ||
        (roleGroup === 'all_listed' && operation !== 'remove')) {
        return interaction.editReply('❌ خيار الرتبة غير معروف.');
    }
    const roleDefinitions = roleGroup === 'all_listed'
        ? ALL_MANAGEABLE_ROLES
        : MANAGEABLE_ROLES[roleGroup];
    if (!roleDefinitions) {
        return interaction.editReply('❌ خيار الرتبة غير معروف.');
    }

    const roles = roleDefinitions.map(definition => interaction.guild.roles.cache.get(definition.id));
    if (roles.some(role => !role || role.managed || !role.editable)) {
        return interaction.editReply('❌ تعذر تعديل إحدى الرتب. تأكد أن الرتب موجودة وأسفل رتبة البوت.');
    }

    const changedRoles = roles.filter(role =>
        operation === 'grant'
            ? !target.roles.cache.has(role.id)
            : target.roles.cache.has(role.id)
    );
    if (!changedRoles.length) {
        return interaction.editReply(
            operation === 'grant'
                ? `ℹ️ <@${target.id}> لديه الرتب المطلوبة بالفعل.`
                : `ℹ️ <@${target.id}> لا يملك أيًا من الرتب المحددة لسحبها.`
        );
    }

    const reason = `Requested by operations manager ${interaction.user.id} via /manage-roles`;
    if (operation === 'grant') {
        await target.roles.add(changedRoles, reason);
    } else {
        await target.roles.remove(changedRoles, reason);
    }

    const roleLabels = changedRoles.map(role =>
        roleDefinitions.find(definition => definition.id === role.id)?.label ?? role.name
    );
    const verb = operation === 'grant' ? 'إعطاء' : 'سحب';
    return interaction.editReply(
        `✅ تم ${verb} ${roleLabels.map(label => `**${label}**`).join(' و')} من <@${target.id}>.`
    );
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    try {
        await registerCommands();
        console.log('Bot is ready and handler updated');
    } catch (error) {
        console.error('Could not register slash commands:', error);
        client.destroy();
        process.exitCode = 1;
    }
});

client.on('messageCreate', handleTextAttendance);
client.on('messageCreate', handleKickCommand);

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('role_ping:')) {
            return await handleRoleMentionConfirmation(interaction);
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (interaction.isChatInputCommand()) {
            const commandName = interaction.commandName;
            console.log(`Received slash command /${commandName} (${interaction.id}).`);
            console.log(`Acknowledged slash command /${commandName} (${interaction.id}).`);

            const allowedChannel = commandName === 'mention-role' ||
                (commandName === 'manage-roles'
                    ? interaction.channelId === ROLE_MANAGEMENT_CHANNEL_ID
                    : ALLOWED_CHANNEL_IDS.has(interaction.channelId));
            if (!allowedChannel) {
                return interaction.editReply(
                    commandName === 'manage-roles'
                        ? '❌ أمر إدارة الرتب متاح فقط في روم إعطاء الرتب.'
                        : '❌ أوامر البوت متاحة فقط في القناتين المخصصتين.'
                );
            }

            if (!interaction.inGuild()) {
                return interaction.editReply('هذه الأوامر متاحة داخل خوادم Discord فقط.');
            }

            if (commandName === 'login') return await handleLogin(interaction);
            if (commandName === 'logout') return await handleLogout(interaction);
            if (commandName === 'manage-roles') {
                return await handleManageRoles(interaction);
            }
            if (commandName === 'admin') {
                return await handleAdminCommand(interaction);
            }
            if (commandName === 'mention-role') {
                return await handleRoleMentionCommand(interaction);
            }
            return interaction.editReply('هذا الأمر غير مدعوم.');
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith('department_select:')
        ) {
            if (!ALLOWED_CHANNEL_IDS.has(interaction.channelId)) {
                return interaction.editReply('❌ تفاعلات البوت متاحة فقط في القناتين المخصصتين.');
            }
            if (!interaction.inGuild()) {
                return interaction.editReply('هذه التفاعلات متاحة داخل خوادم Discord فقط.');
            }

            const menuOwnerId = interaction.customId.slice('department_select:'.length);
            if (interaction.user.id !== menuOwnerId) {
                return interaction.editReply('❌ هذه القائمة ليست لك. استخدم `/login` لفتح قائمتك الخاصة.');
            }

            const department = DEPARTMENTS.find(item => item.value === interaction.values[0]);
            if (!department) {
                await interaction.message.edit({ components: [] });
                return interaction.editReply('❌ القسم المحدد غير معروف.');
            }

            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (store.getSession(interaction.guildId, interaction.user.id)) {
                await interaction.message.edit({ components: [] });
                return interaction.editReply('❌ أنت مسجل دخول بالفعل. سجّل الخروج أولًا قبل بدء جلسة أخرى.');
            }

            if (!hasRole(member, department.id)) {
                await interaction.message.edit({ components: [] });
                return interaction.editReply(`❌ تعذر تسجيل الدخول إلى قسم **${department.label}**؛ لا تملك رتبة تخوّلك الوصول إليه.`);
            }

            store.startSession(interaction.guildId, interaction.user.id, department.value);
            await interaction.message.edit({
                content: `✅ تم تسجيل دخولك بنجاح إلى قسم **${department.label}** وبدأ احتساب الوقت. لم يتم تغيير رتبك.`,
                components: []
            });
            return interaction.editReply(`✅ تم تسجيل دخولك إلى **${department.label}**، وظهر تسجيلك في القناة.`);
        }

    } catch (error) {
        console.error(
            `Interaction failed (${interaction.commandName ?? interaction.customId ?? interaction.type}, ${interaction.id}):`,
            error
        );
        const payload = {
            content: '❌ حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى أو أبلغ المدير.',
            flags: MessageFlags.Ephemeral
        };
        try {
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply(payload);
            } else if (interaction.replied) {
                await interaction.followUp(payload);
            } else if (interaction.isChatInputCommand()) {
                await interaction.reply(payload);
            }
        } catch (responseError) {
            console.error(`Could not send interaction error response (${interaction.id}):`, responseError);
        }
    }
});

if (!process.env.DISCORD_TOKEN) {
    console.error('Set DISCORD_TOKEN in the environment before starting the bot.');
    process.exitCode = 1;
} else if (!CLIENT_ID) {
    console.error('Set CLIENT_ID in the environment to register guild commands.');
    process.exitCode = 1;
} else {
    client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error('Discord login failed:', error);
        process.exitCode = 1;
    });
}
