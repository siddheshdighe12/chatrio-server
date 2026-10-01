import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ConversationType, MemberRole, MessageType } from '../src/types/database.js';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'password123';

async function main() {
  console.log('🌱  Seeding Chatrio database...');

  const hashed = await bcrypt.hash(SEED_PASSWORD, 12);

  // ── Users ──────────────────────────────────────────────────────────────────
  const alice = await prisma.user.upsert({
    where: { email: 'alice@chatrio.dev' },
    update: {},
    create: {
      email: 'alice@chatrio.dev',
      username: 'alice',
      password: hashed,
      displayName: 'Alice Chen',
      bio: 'Product designer & coffee enthusiast ☕',
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=alice`,
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@chatrio.dev' },
    update: {},
    create: {
      email: 'bob@chatrio.dev',
      username: 'bob',
      password: hashed,
      displayName: 'Bob Martinez',
      bio: 'Full-stack engineer. Building things.',
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=bob`,
    },
  });

  const carol = await prisma.user.upsert({
    where: { email: 'carol@chatrio.dev' },
    update: {},
    create: {
      email: 'carol@chatrio.dev',
      username: 'carol',
      password: hashed,
      displayName: 'Carol Kim',
      bio: 'UX researcher | Making the web more human.',
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=carol`,
    },
  });

  const dave = await prisma.user.upsert({
    where: { email: 'dave@chatrio.dev' },
    update: {},
    create: {
      email: 'dave@chatrio.dev',
      username: 'dave',
      password: hashed,
      displayName: 'Dave Park',
      bio: 'Backend architect. Database evangelist.',
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=dave`,
    },
  });

  const eve = await prisma.user.upsert({
    where: { email: 'eve@chatrio.dev' },
    update: {},
    create: {
      email: 'eve@chatrio.dev',
      username: 'eve',
      password: hashed,
      displayName: 'Eve Johnson',
      bio: 'Mobile dev 📱 iOS & Android',
      avatarUrl: null,
    },
  });

  // Siddhesh – try by email, then by username, then create
  const siddhesh =
    (await prisma.user.findUnique({ where: { email: 'siddhesh@chatrio.dev' } })) ??
    (await prisma.user.findUnique({ where: { username: 'siddhesh' } })) ??
    (await prisma.user.create({
      data: {
        email: 'siddhesh@chatrio.dev',
        username: 'siddhesh',
        password: hashed,
        displayName: 'Siddhesh',
        bio: 'Chatrio Lead Developer',
        avatarUrl: null,
      },
    }));

  // Ritesh – try by email, then by username, then create
  const ritesh =
    (await prisma.user.findUnique({ where: { email: 'ritesh@chatrio.dev' } })) ??
    (await prisma.user.findUnique({ where: { username: 'ritesh' } })) ??
    (await prisma.user.create({
      data: {
        email: 'ritesh@chatrio.dev',
        username: 'ritesh',
        password: hashed,
        displayName: 'Ritesh',
        bio: 'Building Chatrio experiences',
        avatarUrl: null,
      },
    }));

  console.log(`✅  Created seed users`);

  // ── One-to-one: Siddhesh ↔ Ritesh ──────────────────────────────────────────
  const existingSiddheshRitesh = await prisma.conversation.findFirst({
    where: {
      type: ConversationType.DIRECT,
      AND: [
        { members: { some: { userId: siddhesh.id } } },
        { members: { some: { userId: ritesh.id } } },
      ],
    },
  });

  if (!existingSiddheshRitesh) {
    const srConv = await prisma.conversation.create({
      data: {
        type: ConversationType.DIRECT,
        members: {
          create: [
            { userId: siddhesh.id, role: MemberRole.MEMBER },
            { userId: ritesh.id, role: MemberRole.MEMBER },
          ],
        },
      },
    });

    await prisma.message.create({
      data: {
        conversationId: srConv.id,
        senderId: ritesh.id,
        type: MessageType.TEXT,
        content: "Hey Siddhesh, how is the testing going?",
        createdAt: new Date(Date.now() - 1000 * 60 * 5),
      },
    });
  }

  // ── One-to-one: Alice ↔ Bob ────────────────────────────────────────────────
  const aliceBobConv = await prisma.conversation.create({
    data: {
      type: ConversationType.DIRECT,
      members: {
        create: [
          { userId: alice.id, role: MemberRole.MEMBER },
          { userId: bob.id, role: MemberRole.MEMBER },
        ],
      },
    },
  });

  // Messages in Alice-Bob conversation
  const msg1 = await prisma.message.create({
    data: {
      conversationId: aliceBobConv.id,
      senderId: alice.id,
      type: MessageType.TEXT,
      content: "Hey Bob! Have you had a chance to review the new Chatrio designs?",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2h ago
    },
  });

  const msg2 = await prisma.message.create({
    data: {
      conversationId: aliceBobConv.id,
      senderId: bob.id,
      type: MessageType.TEXT,
      content: "Yes! They look great. The new color palette is much better 🎨",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 1.5),
    },
  });

  await prisma.message.create({
    data: {
      conversationId: aliceBobConv.id,
      senderId: alice.id,
      type: MessageType.TEXT,
      content: "Thanks! I was going for something more minimal. Are you free for a quick call later?",
      createdAt: new Date(Date.now() - 1000 * 60 * 30), // 30min ago
    },
  });

  await prisma.message.create({
    data: {
      conversationId: aliceBobConv.id,
      senderId: bob.id,
      type: MessageType.TEXT,
      content: "Sure, 4pm works for me 👍",
      createdAt: new Date(Date.now() - 1000 * 60 * 10), // 10min ago
    },
  });

  // Reaction on msg1
  await prisma.messageReaction.create({
    data: { messageId: msg1.id, userId: bob.id, emoji: '👍' },
  });

  // ── One-to-one: Alice ↔ Carol ─────────────────────────────────────────────
  const aliceCarolConv = await prisma.conversation.create({
    data: {
      type: ConversationType.DIRECT,
      members: {
        create: [
          { userId: alice.id, role: MemberRole.MEMBER },
          { userId: carol.id, role: MemberRole.MEMBER },
        ],
      },
    },
  });

  await prisma.message.create({
    data: {
      conversationId: aliceCarolConv.id,
      senderId: carol.id,
      type: MessageType.TEXT,
      content: "Alice, can you share the user research findings from last week?",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24), // 1 day ago
    },
  });

  await prisma.message.create({
    data: {
      conversationId: aliceCarolConv.id,
      senderId: alice.id,
      type: MessageType.TEXT,
      content: "Of course! I'll send the report shortly 📄",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 23),
    },
  });

  // ── One-to-one: Bob ↔ Dave ────────────────────────────────────────────────
  const bobDaveConv = await prisma.conversation.create({
    data: {
      type: ConversationType.DIRECT,
      members: {
        create: [
          { userId: bob.id, role: MemberRole.MEMBER },
          { userId: dave.id, role: MemberRole.MEMBER },
        ],
      },
    },
  });

  await prisma.message.create({
    data: {
      conversationId: bobDaveConv.id,
      senderId: dave.id,
      type: MessageType.TEXT,
      content: "The query performance is much better after adding the composite index 🚀",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5),
    },
  });

  await prisma.message.create({
    data: {
      conversationId: bobDaveConv.id,
      senderId: bob.id,
      type: MessageType.TEXT,
      content: "Great! What was the latency before vs after?",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4),
    },
  });

  // ── Group: Chatrio Team ───────────────────────────────────────────────────
  const teamGroup = await prisma.conversation.create({
    data: {
      type: ConversationType.GROUP,
      name: 'Chatrio Team 🚀',
      avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=CT&backgroundColor=6366f1`,
      members: {
        create: [
          { userId: alice.id, role: MemberRole.OWNER },
          { userId: bob.id, role: MemberRole.ADMIN },
          { userId: carol.id, role: MemberRole.MEMBER },
          { userId: dave.id, role: MemberRole.MEMBER },
          { userId: eve.id, role: MemberRole.MEMBER },
        ],
      },
    },
  });

  // System: group created
  await prisma.message.create({
    data: {
      conversationId: teamGroup.id,
      senderId: null,
      type: MessageType.SYSTEM,
      content: 'Alice created the group',
      metadata: JSON.stringify({ event: 'GROUP_CREATED', actorId: alice.id }),
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7), // 1 week ago
    },
  });

  await prisma.message.create({
    data: {
      conversationId: teamGroup.id,
      senderId: alice.id,
      type: MessageType.TEXT,
      content: "Welcome to the Chatrio team chat! 🎉 Let's build something amazing.",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7 + 1000),
    },
  });

  const teamMsg = await prisma.message.create({
    data: {
      conversationId: teamGroup.id,
      senderId: bob.id,
      type: MessageType.TEXT,
      content: "Backend and Mobile are coming together nicely. Phase 1 almost done 💪",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
    },
  });

  await prisma.message.create({
    data: {
      conversationId: teamGroup.id,
      senderId: carol.id,
      type: MessageType.TEXT,
      content: "Designs are looking incredible! Can't wait to see it all together.",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 1),
    },
  });

  await prisma.message.create({
    data: {
      conversationId: teamGroup.id,
      senderId: eve.id,
      type: MessageType.TEXT,
      content: "Mobile app is smooth 📱 Testing on both iOS and Android now.",
      createdAt: new Date(Date.now() - 1000 * 60 * 20),
    },
  });

  // Group reactions
  await prisma.messageReaction.createMany({
    data: [
      { messageId: teamMsg.id, userId: alice.id, emoji: '🔥' },
      { messageId: teamMsg.id, userId: carol.id, emoji: '❤️' },
      { messageId: teamMsg.id, userId: eve.id, emoji: '👍' },
    ],
  });

  // Update conversation updatedAt (so ordering works)
  await prisma.conversation.update({
    where: { id: aliceBobConv.id },
    data: { updatedAt: new Date(Date.now() - 1000 * 60 * 10) },
  });
  await prisma.conversation.update({
    where: { id: teamGroup.id },
    data: { updatedAt: new Date(Date.now() - 1000 * 60 * 20) },
  });

  console.log('✅  Created conversations and messages');
  console.log('\n📋  Seed users (all passwords: "password123"):');
  console.log('  alice@chatrio.dev  (username: alice)');
  console.log('  bob@chatrio.dev    (username: bob)');
  console.log('  carol@chatrio.dev  (username: carol)');
  console.log('  dave@chatrio.dev   (username: dave)');
  console.log('  eve@chatrio.dev    (username: eve)');
  console.log('\n🎉  Seed complete!');
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
