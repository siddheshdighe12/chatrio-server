import 'dotenv/config';
import { PrismaClient as PostgresClient } from '@prisma/client';
import { PrismaClient as SqliteClient } from '../generated-sqlite';

const sqlite = new SqliteClient();
const postgres = new PostgresClient();

async function main() {
    console.log('🔄 Starting SQLite → PostgreSQL migration...');

    // Read data from the old SQLite database.
    const users = await sqlite.user.findMany();
    const conversations = await sqlite.conversation.findMany();
    const members = await sqlite.conversationMember.findMany();
    const messages = await sqlite.message.findMany();
    const reactions = await sqlite.messageReaction.findMany();
    const reads = await sqlite.messageRead.findMany();
    const deliveries = await sqlite.messageDelivery.findMany();
    const attachments = await sqlite.attachment.findMany();
    const blockedUsers = await sqlite.blockedUser.findMany();
    const reports = await sqlite.report.findMany();

    console.log(`📦 Users: ${users.length}`);
    console.log(`📦 Conversations: ${conversations.length}`);
    console.log(`📦 Messages: ${messages.length}`);
    console.log(`📦 Reactions: ${reactions.length}`);
    console.log(`📦 Reads: ${reads.length}`);
    console.log(`📦 Deliveries: ${deliveries.length}`);
    console.log(`📦 Attachments: ${attachments.length}`);
    console.log(`📦 Blocked users: ${blockedUsers.length}`);
    console.log(`📦 Reports: ${reports.length}`);

    await postgres.$transaction(
        async (tx) => {
            console.log('🧹 Clearing seeded PostgreSQL data...');

            // Delete dependent records first because of foreign keys.
            await tx.messageReaction.deleteMany();
            await tx.messageRead.deleteMany();
            await tx.messageDelivery.deleteMany();
            await tx.attachment.deleteMany();
            await tx.message.deleteMany();
            await tx.conversationMember.deleteMany();
            await tx.blockedUser.deleteMany();
            await tx.report.deleteMany();
            await tx.conversation.deleteMany();
            await tx.refreshToken.deleteMany();
            await tx.user.deleteMany();

            console.log('👤 Copying users...');

            await tx.user.createMany({
                data: users.map((u) => ({
                    id: u.id,
                    username: u.username,
                    email: u.email,
                    password: u.password,
                    displayName: u.displayName,
                    bio: u.bio,
                    avatarUrl: u.avatarUrl,
                    isOnline: false,
                    lastSeenAt: u.lastSeenAt,
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt,
                    showReadReceipts: u.showReadReceipts,
                    showTypingStatus: u.showTypingStatus,
                })),
            });

            console.log('💬 Copying conversations...');

            await tx.conversation.createMany({
                data: conversations.map((c) => ({
                    id: c.id,
                    type: c.type,
                    name: c.name,
                    avatarUrl: c.avatarUrl,
                    description: c.description,
                    createdAt: c.createdAt,
                    updatedAt: c.updatedAt,
                })),
            });

            console.log('👥 Copying conversation members...');

            await tx.conversationMember.createMany({
                data: members.map((m) => ({
                    id: m.id,
                    conversationId: m.conversationId,
                    userId: m.userId,
                    role: m.role,
                    joinedAt: m.joinedAt,
                    leftAt: m.leftAt,
                    isActive: m.isActive,
                    isMuted: m.isMuted,
                    isPinned: m.isPinned,
                    isArchived: m.isArchived,
                })),
            });

            console.log('✉️ Copying messages...');

            await tx.message.createMany({
                data: messages.map((m) => ({
                    id: m.id,
                    conversationId: m.conversationId,
                    senderId: m.senderId,
                    type: m.type,
                    content: m.content,
                    status: m.status,
                    isEdited: m.isEdited,
                    editedAt: m.editedAt,
                    isDeleted: m.isDeleted,
                    deletedAt: m.deletedAt,
                    deletedForUserIds: m.deletedForUserIds,
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt,
                    replyToId: m.replyToId,
                    metadata: m.metadata,
                })),
            });

            console.log('❤️ Copying reactions...');

            await tx.messageReaction.createMany({
                data: reactions.map((r) => ({
                    id: r.id,
                    messageId: r.messageId,
                    userId: r.userId,
                    emoji: r.emoji,
                    createdAt: r.createdAt,
                })),
            });

            console.log('👀 Copying read receipts...');

            await tx.messageRead.createMany({
                data: reads.map((r) => ({
                    id: r.id,
                    messageId: r.messageId,
                    userId: r.userId,
                    readAt: r.readAt,
                })),
            });

            console.log('📬 Copying delivery receipts...');

            await tx.messageDelivery.createMany({
                data: deliveries.map((d) => ({
                    id: d.id,
                    messageId: d.messageId,
                    userId: d.userId,
                    deliveredAt: d.deliveredAt,
                })),
            });

            console.log('📎 Copying attachments...');

            await tx.attachment.createMany({
                data: attachments.map((a) => ({
                    id: a.id,
                    messageId: a.messageId,
                    type: a.type,
                    fileName: a.fileName,
                    mimeType: a.mimeType,
                    size: a.size,
                    storageKey: a.storageKey,
                    url: a.url,
                    width: a.width,
                    height: a.height,
                    duration: a.duration,
                    createdAt: a.createdAt,
                })),
            });

            console.log('🚫 Copying blocked users...');

            await tx.blockedUser.createMany({
                data: blockedUsers.map((b) => ({
                    id: b.id,
                    userId: b.userId,
                    blockedId: b.blockedId,
                    createdAt: b.createdAt,
                })),
            });

            console.log('🚩 Copying reports...');

            await tx.report.createMany({
                data: reports.map((r) => ({
                    id: r.id,
                    reporterId: r.reporterId,
                    targetId: r.targetId,
                    targetType: r.targetType,
                    reason: r.reason,
                    createdAt: r.createdAt,
                })),
            });
        },
        {
            maxWait: 10000,
            timeout: 60000,
        },
    );

    console.log('');
    console.log('✅ Migration completed successfully!');
    console.log('🔐 Old refresh tokens were NOT migrated.');
    console.log('📱 Siddhesh will need to log in again for a fresh session.');
}

main()
    .catch((error) => {
        console.error('❌ Migration failed:', error);
        throw error;
    })
    .finally(async () => {
        await sqlite.$disconnect();
        await postgres.$disconnect();
    });