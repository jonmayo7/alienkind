/**
 * Memory file indexer for Keel.
 *
 * Reads memory files, chunks them by section (## headers), and upserts
 * to Supabase memory_chunks table for full-text + vector search.
 *
 * Checksums prevent re-indexing unchanged chunks. Only modified sections
 * get updated. New/changed chunks automatically get embeddings via
 * Qwen3-Embedding 8B via vLLM-MLX (4096 dims stored, 1024-dim Matryoshka
 * truncation for IVFFlat-indexed search).
 *
 * Readers: memory-search.ts (hybrid search)
 * Writers: Supabase memory_chunks (content + embedding + embedding_1024)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { loadEnv } = require('./shared.ts');

const KEEL_DIR = path.resolve(__dirname, '../..');

interface IndexTarget {
  glob?: string;
  file?: string;
  type: string;
}

interface Chunk {
  heading: string | null;
  content: string;
}

interface IndexResult {
  file: string;
  indexed: number;
  skipped: number;
  deleted: number;
  error?: string;
}

interface IndexTotals {
  total: number;
  indexed: number;
  skipped: number;
  deleted: number;
}

interface SupabaseCredentials {
  url: string;
  key: string;
}

interface IndexFileOptions extends SupabaseCredentials {
  log: (...args: any[]) => void;
  dryRun?: boolean;
}

interface IndexAllOptions {
  log: (...args: any[]) => void;
  dryRun?: boolean;
}

// Files to index, relative to KEEL_DIR
// Add new directories here as memory expands — indexer auto-discovers files via globs
const INDEX_TARGETS: IndexTarget[] = [
  // Daily memory
  { glob: 'memory/daily/*.md', type: 'daily' },
  // Identity kernel
  { file: 'identity/character.md', type: 'identity' },
  { file: 'identity/harness.md', type: 'identity' },
  { file: 'identity/harness-reference.md', type: 'identity' },
  { file: 'identity/user.md', type: 'identity' },
  { file: 'identity/commitments.md', type: 'identity' },
  { file: 'identity/orientation.md', type: 'identity' },
  // Core memory files
  { file: 'memory/MEMORY.md', type: 'memory' },
  { file: 'memory/BUILD_LOG_ARCHIVE.md', type: 'build_log' },
  { file: 'BUILD_LOG.md', type: 'build_log' },
  // Synthesis (clients, themes, archive)
  { glob: 'memory/synthesis/*.md', type: 'synthesis' },
  { glob: 'memory/synthesis/clients/*.md', type: 'synthesis' },
  { glob: 'memory/synthesis/archive/*.md', type: 'synthesis' },
  // Learning
  { glob: 'memory/learning/*.md', type: 'learning' },
  // Research
  { glob: 'memory/research/*.md', type: 'research' },
  // Extraction
  { glob: 'memory/extraction/*.md', type: 'extraction' },
  // Project scopes
  { glob: 'memory/project-scopes/*.md', type: 'project_scope' },
  // CONOPs
  { glob: 'memory/conops/*.md', type: 'conop' },
  // Archive research
  { glob: 'memory/archive/research/*.md', type: 'research' },
  // SOTU
  { glob: 'memory/sotu*.md', type: 'sotu' },
  // Drafts (article drafts)
  { glob: 'memory/drafts/*.md', type: 'draft' },
  // Skills
  { glob: 'skills/*/SKILL.md', type: 'skill' },
  // CLAUDE.md (operational identity)
  { file: 'CLAUDE.md', type: 'identity' },
  // Config docs
  { file: 'config/WIRING_MANIFEST.md', type: 'config' },
];

// --- Chunking ---
function chunkFile(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0 || currentHeading) {
        const body = currentBody.join('\n').trim();
        if (body.length > 0) {
          chunks.push({ heading: currentHeading, content: body });
        }
      }
      currentHeading = headingMatch[2].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  const body = currentBody.join('\n').trim();
  if (body.length > 0) {
    chunks.push({ heading: currentHeading, content: body });
  }

  return chunks;
}

function extractDate(filePath: string): string | null {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

// --- Supabase Operations ---
function supabaseRequest(method: string, reqPath: string, body: any, { url, key }: SupabaseCredentials): Promise<any> {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${url}/rest/v1/${reqPath}`);
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    };

    const req = https.request(fullUrl, { method, headers }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${method} ${reqPath}: ${res.statusCode} ${data.slice(0, 200)}`));
        } else {
          resolve(data ? JSON.parse(data) : null);
        }
      });
    });

    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Supabase ${method} ${reqPath}: timeout after 30s`)); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getExistingChecksums(sourceFile: string, creds: SupabaseCredentials): Promise<Record<number, string>> {
  const encoded = encodeURIComponent(sourceFile);
  const result = await supabaseRequest('GET', `memory_chunks?source_file=eq.${encoded}&select=chunk_index,checksum`, null, creds);
  const map: Record<number, string> = {};
  if (Array.isArray(result)) {
    for (const row of result) {
      map[row.chunk_index] = row.checksum;
    }
  }
  return map;
}

async function upsertChunk(chunk: any, creds: SupabaseCredentials): Promise<void> {
  await supabaseRequest('POST', 'memory_chunks?on_conflict=source_file,chunk_index', chunk, creds);
}

async function deleteExcessChunks(sourceFile: string, maxIndex: number, creds: SupabaseCredentials): Promise<void> {
  const encoded = encodeURIComponent(sourceFile);
  await supabaseRequest('DELETE', `memory_chunks?source_file=eq.${encoded}&chunk_index=gt.${maxIndex}`, null, creds);
}

// --- Embedding Generation (vLLM-MLX, OpenAI-compatible API) ---
// Port 8000 (nginx) routes /v1/embeddings → vLLM-MLX (port 8004), chat → mlx_lm.server (port 8001)
const LOCAL_HOST = process.env.LOCAL_HOST || process.env.OMLX_HOST || 'http://localhost:8000';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ';

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    return await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8192) });
      const embUrl = new URL(`${LOCAL_HOST}/v1/embeddings`);
      const req = http.request(embUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) { resolve(null); return; }
          try {
            const j = JSON.parse(data);
            // OpenAI format: { data: [{ embedding: [...] }] }
            const emb = j.data?.[0]?.embedding || (j.embedding && Array.isArray(j.embedding) ? j.embedding : null);
            resolve(emb);
          } catch { resolve(null); }
        });
      });
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

async function saveEmbedding(chunkId: number, embedding: number[], creds: SupabaseCredentials): Promise<boolean> {
  try {
    const patchUrl = new URL(`${creds.url}/rest/v1/memory_chunks?id=eq.${chunkId}`);
    // Write both columns: full 4096-dim + truncated 1024-dim for indexed search
    const embedding1024 = embedding.slice(0, 1024);
    const body = JSON.stringify({
      embedding: JSON.stringify(embedding),
      embedding_1024: JSON.stringify(embedding1024),
    });
    return await new Promise((resolve) => {
      const req = https.request(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': creds.key, 'Authorization': `Bearer ${creds.key}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => resolve(res.statusCode < 400));
      });
      req.setTimeout(15000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.write(body);
      req.end();
    });
  } catch { return false; }
}

// --- Index a single file ---
async function indexFile(filePath: string, fileType: string, { url, key, log, dryRun = false }: IndexFileOptions): Promise<IndexResult> {
  const relativePath = path.relative(KEEL_DIR, filePath);
  if (!fs.existsSync(filePath)) {
    log('WARN', `File not found: ${relativePath}`);
    return { file: relativePath, indexed: 0, skipped: 0, deleted: 0 };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim().length === 0) {
    return { file: relativePath, indexed: 0, skipped: 0, deleted: 0 };
  }

  const chunks = chunkFile(content);
  const fileDate = extractDate(relativePath);
  const existingChecksums = dryRun ? {} : await getExistingChecksums(relativePath, { url, key });

  let indexed = 0;
  let skipped = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const checksum = md5(chunk.content);

    if (existingChecksums[i] === checksum) {
      skipped++;
      continue;
    }

    if (dryRun) {
      log('INFO', `[DRY RUN] Would index: ${relativePath} chunk ${i} (${chunk.heading || 'no heading'}, ${chunk.content.length} chars)`);
      indexed++;
      continue;
    }

    await upsertChunk({
      source_file: relativePath,
      chunk_index: i,
      heading: chunk.heading || null,
      content: chunk.content,
      file_type: fileType,
      file_date: fileDate || null,
      checksum,
      updated_at: new Date().toISOString(),
    }, { url, key });

    // Generate and save embedding for new/changed chunks
    const embText = `${chunk.heading || ''}\n${chunk.content}`.trim();
    const embedding = await generateEmbedding(embText);
    if (embedding) {
      // Get the chunk ID for the embedding save
      try {
        const lookupResult = await supabaseRequest(
          'GET',
          `memory_chunks?source_file=eq.${encodeURIComponent(relativePath)}&chunk_index=eq.${i}&select=id`,
          null, { url, key }
        );
        if (Array.isArray(lookupResult) && lookupResult[0]?.id) {
          await saveEmbedding(lookupResult[0].id, embedding, { url, key });
        }
      } catch { /* embedding save failed — chunk still indexed, embedding can be backfilled */ }
    }

    indexed++;
  }

  // Clean up excess chunks (file got shorter since last index)
  let deleted = 0;
  if (!dryRun && chunks.length < Object.keys(existingChecksums).length) {
    await deleteExcessChunks(relativePath, chunks.length - 1, { url, key });
    deleted = Object.keys(existingChecksums).length - chunks.length;
  }

  return { file: relativePath, indexed, skipped, deleted };
}

// --- Resolve glob patterns ---
function resolveGlob(pattern: string): string[] {
  const dir = path.join(KEEL_DIR, path.dirname(pattern));
  const filePattern = path.basename(pattern);
  if (!fs.existsSync(dir)) return [];

  const regex = new RegExp('^' + filePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return fs.readdirSync(dir)
    .filter((f: string) => regex.test(f))
    .map((f: string) => path.join(dir, f))
    .sort();
}

// --- Index all targets ---
async function indexAll({ log, dryRun = false }: IndexAllOptions): Promise<IndexTotals> {
  const env = loadEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    log('WARN', 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — cannot index');
    return { total: 0, indexed: 0, skipped: 0, deleted: 0 };
  }

  const results: IndexResult[] = [];

  for (const target of INDEX_TARGETS) {
    const files = target.glob
      ? resolveGlob(target.glob)
      : [path.join(KEEL_DIR, target.file!)];

    for (const filePath of files) {
      try {
        const result = await indexFile(filePath, target.type, { url, key, log, dryRun });
        results.push(result);
        if (result.indexed > 0 || result.deleted > 0) {
          log('INFO', `Indexed ${result.file}: ${result.indexed} new/updated, ${result.skipped} unchanged, ${result.deleted} removed`);
        }
      } catch (err: any) {
        log('WARN', `Failed to index ${filePath}: ${err.message}`);
        results.push({ file: path.relative(KEEL_DIR, filePath), indexed: 0, skipped: 0, deleted: 0, error: err.message });
      }
    }
  }

  const totals = results.reduce((acc, r) => ({
    total: acc.total + 1,
    indexed: acc.indexed + r.indexed,
    skipped: acc.skipped + r.skipped,
    deleted: acc.deleted + r.deleted,
  }), { total: 0, indexed: 0, skipped: 0, deleted: 0 });

  return totals;
}

module.exports = { indexAll, indexFile };

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const specificFile = args.find((a: string) => !a.startsWith('--'));
  const log = (level: string, msg: string) => console.log(`[${level}] ${msg}`);

  (async () => {
    if (specificFile) {
      const env = loadEnv();
      const filePath = path.resolve(KEEL_DIR, specificFile);
      const type = specificFile.includes('daily') ? 'daily'
        : specificFile.includes('MEMORY') ? 'memory'
        : specificFile.includes('BUILD_LOG') ? 'build_log'
        : specificFile.includes('identity/') ? 'identity'
        : 'other';
      const result = await indexFile(filePath, type, {
        url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, log, dryRun,
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await indexAll({ log, dryRun });
      console.log(`\nTotal: ${result.total} files, ${result.indexed} chunks indexed, ${result.skipped} unchanged, ${result.deleted} removed`);
    }
  })().catch((err: any) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
