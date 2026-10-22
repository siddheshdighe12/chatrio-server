-- CreateTable
CREATE TABLE "group_calls" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "callType" TEXT NOT NULL DEFAULT 'AUDIO',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "livekitRoom" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_call_participants" (
    "id" TEXT NOT NULL,
    "groupCallId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "group_call_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_calls_livekitRoom_key" ON "group_calls"("livekitRoom");

-- CreateIndex
CREATE INDEX "group_calls_conversationId_idx" ON "group_calls"("conversationId");

-- CreateIndex
CREATE INDEX "group_calls_initiatorId_idx" ON "group_calls"("initiatorId");

-- CreateIndex
CREATE INDEX "group_calls_status_idx" ON "group_calls"("status");

-- CreateIndex
CREATE INDEX "group_call_participants_groupCallId_idx" ON "group_call_participants"("groupCallId");

-- CreateIndex
CREATE INDEX "group_call_participants_userId_idx" ON "group_call_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_call_participants_groupCallId_userId_key" ON "group_call_participants"("groupCallId", "userId");

-- AddForeignKey
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_call_participants" ADD CONSTRAINT "group_call_participants_groupCallId_fkey" FOREIGN KEY ("groupCallId") REFERENCES "group_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_call_participants" ADD CONSTRAINT "group_call_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
