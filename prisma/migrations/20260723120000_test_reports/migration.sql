-- Test suites, cases, runs (reports), and artifacts
CREATE TABLE "TestSuite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "feature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "TestSuite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TestCase" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ui',
    "feature" TEXT,
    "askTitle" TEXT,
    "askDescription" TEXT,
    "priority" TEXT,
    "type" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "acceptanceCriteria" JSONB,
    "automation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "suiteId" TEXT NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ui',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "askTitle" TEXT,
    "feature" TEXT,
    "runMode" TEXT,
    "log" TEXT,
    "runSteps" JSONB,
    "runSummary" JSONB,
    "acResults" JSONB,
    "specPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "suiteId" TEXT,
    "caseId" TEXT,
    "parentRunId" TEXT,

    CONSTRAINT "TestRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunArtifact" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "relativePath" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,

    CONSTRAINT "RunArtifact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TestSuite_projectId_idx" ON "TestSuite"("projectId");
CREATE INDEX "TestCase_suiteId_idx" ON "TestCase"("suiteId");
CREATE INDEX "TestRun_projectId_createdAt_idx" ON "TestRun"("projectId", "createdAt");
CREATE INDEX "TestRun_suiteId_idx" ON "TestRun"("suiteId");
CREATE INDEX "TestRun_parentRunId_idx" ON "TestRun"("parentRunId");
CREATE INDEX "RunArtifact_runId_idx" ON "RunArtifact"("runId");

ALTER TABLE "TestSuite" ADD CONSTRAINT "TestSuite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunArtifact" ADD CONSTRAINT "RunArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
