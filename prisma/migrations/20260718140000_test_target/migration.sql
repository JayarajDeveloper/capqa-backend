-- CreateTable
CREATE TABLE IF NOT EXISTS "TestTarget" (
    "id" TEXT NOT NULL,
    "appUrl" TEXT,
    "email" TEXT,
    "passwordCipher" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "TestTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TestTarget_projectId_key" ON "TestTarget"("projectId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TestTarget" ADD CONSTRAINT "TestTarget_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
