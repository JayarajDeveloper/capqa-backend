-- CreateTable
CREATE TABLE "AiSetting" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'demo',
    "model" TEXT,
    "apiKeyCipher" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSetting_projectId_key" ON "AiSetting"("projectId");

-- AddForeignKey
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
