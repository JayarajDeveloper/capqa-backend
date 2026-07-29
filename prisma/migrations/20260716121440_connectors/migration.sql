-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('GITLAB', 'JIRA', 'GITHUB');

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "accountName" TEXT,
    "email" TEXT,
    "tokenCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "webUrl" TEXT,
    "language" TEXT,
    "summary" TEXT,
    "files" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connector_projectId_provider_key" ON "Connector"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_projectId_name_key" ON "Repo"("projectId", "name");

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
