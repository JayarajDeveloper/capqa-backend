-- RAG code chunks (FTS + JSON embeddings — works on stock Postgres, no pgvector required)
CREATE TABLE "RepoIndex" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "commitSha" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repoId" TEXT NOT NULL,

    CONSTRAINT "RepoIndex_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepoIndex_repoId_key" ON "RepoIndex"("repoId");

ALTER TABLE "RepoIndex" ADD CONSTRAINT "RepoIndex_repoId_fkey"
  FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CodeChunk" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "language" TEXT,
    "content" TEXT NOT NULL,
    "embedding" JSONB,
    "search" tsvector,
    "repoId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CodeChunk_projectId_idx" ON "CodeChunk"("projectId");
CREATE INDEX "CodeChunk_repoId_idx" ON "CodeChunk"("repoId");
CREATE INDEX "CodeChunk_search_idx" ON "CodeChunk" USING GIN ("search");

ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_repoId_fkey"
  FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
