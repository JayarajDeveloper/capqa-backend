-- CreateTable
CREATE TABLE "DbTarget" (
    "id" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 5432,
    "database" TEXT,
    "username" TEXT,
    "passwordCipher" TEXT,
    "ssl" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "DbTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DbTarget_projectId_key" ON "DbTarget"("projectId");

-- AddForeignKey
ALTER TABLE "DbTarget" ADD CONSTRAINT "DbTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
