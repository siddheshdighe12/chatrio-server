-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "callType" TEXT NOT NULL DEFAULT 'AUDIO',
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "livekitRoom" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_livekitRoom_key" ON "calls"("livekitRoom");

-- CreateIndex
CREATE INDEX "calls_conversationId_idx" ON "calls"("conversationId");

-- CreateIndex
CREATE INDEX "calls_callerId_idx" ON "calls"("callerId");

-- CreateIndex
CREATE INDEX "calls_recipientId_idx" ON "calls"("recipientId");

-- CreateIndex
CREATE INDEX "calls_status_idx" ON "calls"("status");

-- CreateIndex
CREATE INDEX "calls_createdAt_idx" ON "calls"("createdAt");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
