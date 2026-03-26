#!/usr/bin/env node

import { Command } from 'commander';
import { getDb, saveDb, getStats, setConfig, getConfig, searchByText, searchByEmbedding, insertKnowledge, type KnowledgeItem } from './db.js';
import { generateEmbedding } from './embedding.js';
import { extractIntelligence } from './ai/extract.js';
import { askWithSources } from './ai/ask.js';
import { startServer } from './server/index.js';
import { v4 as uuid } from 'uuid';
import { connectGmail, scanGmail } from './connectors/gmail.js';
import { connectCalendar, scanCalendar } from './connectors/calendar.js';
import { indexDirectory } from './connectors/files.js';
import { importClaudeConversations } from './connectors/claude.js';

const program = new Command();

program
  .name('recall')
  .description('The AI that already knows your business')
  .version('0.1.0');

// ============================================================
// prime init
// ============================================================
program
  .command('init')
  .description('Initialize Prime — set up your knowledge base')
  .action(async () => {
    console.log('\n⚡ PRIME — The AI that already knows your business\n');

    const db = await getDb();

    // Check if already initialized
    const existing = getConfig(db, 'openai_api_key');
    if (existing) {
      console.log('✓ Prime is already initialized.');
      const stats = getStats(db);
      console.log(`  ${stats.total_items} knowledge items indexed.`);
      console.log('\n  Run: prime status    for details');
      console.log('  Run: prime connect gmail    to add Gmail\n');
      return;
    }

    // Get API key
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

    const apiKey = await ask('  OpenAI API key (for embeddings — ~$0.02/1M tokens): ');
    if (!apiKey.startsWith('sk-')) {
      console.log('  ✗ Invalid API key. Must start with sk-');
      rl.close();
      return;
    }

    setConfig(db, 'openai_api_key', apiKey);
    saveDb();

    console.log('\n  ✓ API key saved');
    console.log('  ✓ Knowledge base created at ~/.prime/prime.db');
    console.log('\n  Next: prime connect gmail\n');

    rl.close();
  });

// ============================================================
// prime status
// ============================================================
program
  .command('status')
  .description('Show what Prime knows')
  .action(async () => {
    const db = await getDb();
    const stats = getStats(db);

    console.log('\n⚡ PRIME STATUS\n');
    console.log(`  Knowledge items: ${stats.total_items}`);
    console.log(`  Connections: ${stats.total_connections}`);

    if (stats.by_source.length > 0) {
      console.log('\n  By source:');
      for (const s of stats.by_source) {
        console.log(`    ${s.source}: ${s.count}`);
      }
    }

    if (stats.by_importance.length > 0) {
      console.log('\n  By importance:');
      for (const s of stats.by_importance) {
        console.log(`    ${s.importance}: ${s.count}`);
      }
    }

    if (stats.sync_state.length > 0) {
      console.log('\n  Sync state:');
      for (const s of stats.sync_state) {
        console.log(`    ${s.source}: ${s.items_synced} items, last sync ${s.last_sync_at || 'never'}`);
      }
    }

    console.log('');
  });

// ============================================================
// prime search <query>
// ============================================================
program
  .command('search <query>')
  .description('Search your knowledge base')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-s, --source <source>', 'Filter by source')
  .option('-p, --project <project>', 'Filter by project')
  .action(async (query: string, opts: any) => {
    const db = await getDb();
    const apiKey = getConfig(db, 'openai_api_key');
    const limit = parseInt(opts.limit) || 10;

    let results: any[];

    if (apiKey) {
      // Semantic search
      try {
        const queryEmb = await generateEmbedding(query, apiKey);
        results = searchByEmbedding(db, queryEmb, limit, 0.3);
      } catch {
        // Fallback to text search
        results = searchByText(db, query, limit);
      }
    } else {
      results = searchByText(db, query, limit);
    }

    // Apply filters
    if (opts.source) {
      results = results.filter(r => r.source === opts.source);
    }
    if (opts.project) {
      results = results.filter(r => r.project?.toLowerCase().includes(opts.project.toLowerCase()));
    }

    if (results.length === 0) {
      console.log(`\n  No results for "${query}"\n`);
      return;
    }

    console.log(`\n  Found ${results.length} results for "${query}":\n`);

    for (const r of results) {
      const sim = r.similarity ? ` [${(r.similarity * 100).toFixed(0)}%]` : '';
      const imp = r.importance !== 'normal' ? ` ⚡${r.importance}` : '';
      console.log(`  ${sim} ${r.title}${imp}`);
      console.log(`     ${r.summary}`);
      if (r.source_ref) console.log(`     📎 ${r.source} → ${r.source_ref}`);
      if (r.contacts?.length) console.log(`     👤 ${r.contacts.join(', ')}`);
      if (r.commitments?.length) console.log(`     📋 ${r.commitments.join('; ')}`);
      console.log('');
    }
  });

// ============================================================
// prime remember <text>
// ============================================================
program
  .command('remember <text>')
  .description('Quick capture — add something to your knowledge base')
  .option('-p, --project <project>', 'Associate with a project')
  .option('-i, --importance <level>', 'Importance: low/normal/high/critical', 'normal')
  .action(async (text: string, opts: any) => {
    const db = await getDb();
    const apiKey = getConfig(db, 'openai_api_key');

    if (!apiKey) {
      console.log('  Run: prime init   first');
      return;
    }

    // Extract intelligence
    const extracted = await extractIntelligence(text, apiKey);

    // Generate embedding
    const embeddingText = `${extracted.title}\n\n${extracted.summary}\n\n${text}`;
    const embedding = await generateEmbedding(embeddingText, apiKey);

    const item: KnowledgeItem = {
      id: uuid(),
      title: extracted.title,
      summary: extracted.summary,
      source: 'manual',
      source_ref: `manual:${Date.now()}`,
      source_date: new Date().toISOString(),
      contacts: extracted.contacts,
      organizations: extracted.organizations,
      decisions: extracted.decisions,
      commitments: extracted.commitments,
      action_items: extracted.action_items,
      tags: extracted.tags,
      project: opts.project || extracted.project,
      importance: opts.importance || extracted.importance,
      embedding,
    };

    insertKnowledge(db, item);

    console.log(`\n  ✓ Remembered: ${extracted.title}`);
    if (extracted.contacts.length) console.log(`    👤 Contacts: ${extracted.contacts.join(', ')}`);
    if (extracted.commitments.length) console.log(`    📋 Commitments: ${extracted.commitments.join('; ')}`);
    if (extracted.project) console.log(`    📁 Project: ${extracted.project}`);
    console.log('');
  });

// ============================================================
// prime ingest <file>
// ============================================================
program
  .command('ingest <file>')
  .description('Ingest a file into the knowledge base')
  .option('-p, --project <project>', 'Associate with a project')
  .action(async (file: string, opts: any) => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');

    const filePath = resolve(file);
    const content = readFileSync(filePath, 'utf-8');
    const db = await getDb();
    const apiKey = getConfig(db, 'openai_api_key');

    if (!apiKey) {
      console.log('  Run: prime init   first');
      return;
    }

    const extracted = await extractIntelligence(content, apiKey);
    const embeddingText = `${extracted.title}\n\n${extracted.summary}`;
    const embedding = await generateEmbedding(embeddingText, apiKey);

    const item: KnowledgeItem = {
      id: uuid(),
      title: extracted.title,
      summary: extracted.summary,
      source: 'file',
      source_ref: filePath,
      source_date: new Date().toISOString(),
      contacts: extracted.contacts,
      organizations: extracted.organizations,
      decisions: extracted.decisions,
      commitments: extracted.commitments,
      action_items: extracted.action_items,
      tags: extracted.tags,
      project: opts.project || extracted.project,
      importance: extracted.importance,
      embedding,
      artifact_path: filePath,
    };

    insertKnowledge(db, item);

    console.log(`\n  ✓ Ingested: ${extracted.title}`);
    console.log(`    📄 Source: ${filePath}`);
    if (extracted.contacts.length) console.log(`    👤 Contacts: ${extracted.contacts.join(', ')}`);
    console.log('');
  });

// ============================================================
// prime ask <question>
// ============================================================
program
  .command('ask <question>')
  .description('Ask Prime anything about your business')
  .option('-m, --model <model>', 'LLM model to use', 'gpt-4o-mini')
  .action(async (question: string, opts: any) => {
    const db = await getDb();
    console.log('\n  ⚡ Thinking...\n');

    try {
      const { answer, sources } = await askWithSources(db, question, { model: opts.model });
      console.log(`  ${answer.replace(/\n/g, '\n  ')}`);

      // Show source references
      if (sources.length > 0) {
        console.log('\n  ─────────────────────────────────────');
        console.log('  📎 Sources:');
        for (const s of sources.slice(0, 8)) {
          const sim = s.similarity ? ` (${(s.similarity * 100).toFixed(0)}%)` : '';
          console.log(`     [${s.num}] ${s.title} — ${s.source}${sim}`);
        }
      }
      console.log('');
    } catch (err: any) {
      console.error(`  Error: ${err.message}\n`);
    }
  });

// ============================================================
// prime context <text>
// ============================================================
program
  .command('context <text>')
  .description('Set your business context — Prime uses this to prioritize everything')
  .action(async (text: string) => {
    const db = await getDb();
    setConfig(db, 'business_context', text);
    console.log('\n  ✓ Business context saved. Prime will use this to prioritize.\n');
  });

// ============================================================
// prime connect gmail
// ============================================================
program
  .command('connect')
  .argument('<source>', 'Source to connect (gmail, calendar)')
  .description('Connect a data source')
  .action(async (source: string) => {
    const db = await getDb();

    if (source === 'calendar') {
      console.log('\n⚡ Connecting Google Calendar...\n');
      const success = await connectCalendar(db);
      if (success) {
        console.log('\n  Scanning calendar events...\n');
        const { events, items } = await scanCalendar(db);
        console.log(`  ✓ ${events} events → ${items} knowledge items\n`);
      }
    } else if (source === 'gmail') {
      console.log('\n⚡ Connecting Gmail...\n');
      const success = await connectGmail(db);

      if (success) {
        console.log('\n  Scanning your email... (this takes about 60 seconds)\n');

        const { threads, items } = await scanGmail(db, { days: 90, maxThreads: 100 });

        console.log(`  ████████████████████████ ${threads} threads scanned`);
        console.log(`  ✓ ${items} knowledge items created with embeddings`);

        // Show stats
        const stats = getStats(db);
        console.log(`\n  Total knowledge: ${stats.total_items} items`);

        // Show dropped balls
        const droppedBalls = searchByText(db, 'awaiting_reply', 20)
          .filter(r => {
            const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
            return meta?.waiting_on_user && meta?.days_since_last > 7;
          });

        if (droppedBalls.length > 0) {
          console.log(`\n  ⚠️  ${droppedBalls.length} DROPPED BALLS:`);
          for (const ball of droppedBalls.slice(0, 5)) {
            const meta = typeof ball.metadata === 'string' ? JSON.parse(ball.metadata) : ball.metadata;
            const contacts = Array.isArray(ball.contacts) ? ball.contacts : JSON.parse(ball.contacts || '[]');
            console.log(`     • ${contacts.join(', ') || 'Unknown'} — ${meta?.days_since_last}d with no reply`);
            console.log(`       ${ball.title}`);
          }
        }

        console.log('\n  Try: prime search "who should I follow up with"');
        console.log('  Try: prime ask "what should I focus on today?"\n');
      } else {
        console.log('  ✗ Failed to connect Gmail\n');
      }
    } else {
      console.log(`  Unknown source: ${source}. Available: gmail, calendar\n`);
    }
  });

// ============================================================
// prime index <directory>
// ============================================================
program
  .command('index <directory>')
  .description('Index a directory of files into the knowledge base')
  .option('-p, --project <project>', 'Associate with a project')
  .option('--no-recursive', 'Don\'t recurse into subdirectories')
  .action(async (directory: string, opts: any) => {
    const db = await getDb();
    const { resolve } = await import('path');
    const dir = resolve(directory);

    console.log(`\n  Indexing ${dir}...\n`);
    const { files, items, skipped } = await indexDirectory(db, dir, {
      project: opts.project,
      recursive: opts.recursive !== false,
    });
    console.log(`  ✓ ${files} files processed → ${items} knowledge items (${skipped} skipped)\n`);
  });

// ============================================================
// prime import <source> <path>
// ============================================================
program
  .command('import <source> <path>')
  .description('Import data from an export (claude conversations.json or directory)')
  .option('-p, --project <project>', 'Associate with a project')
  .action(async (source: string, importPath: string, opts: any) => {
    const db = await getDb();
    const { resolve } = await import('path');
    const fullPath = resolve(importPath);

    if (source === 'claude') {
      console.log(`\n  Importing Claude conversations from ${fullPath}...\n`);
      const { conversations, items } = await importClaudeConversations(db, fullPath, { project: opts.project });
      console.log(`  ✓ ${conversations} conversations → ${items} knowledge items\n`);
    } else {
      console.log(`  Unknown import source: ${source}. Available: claude\n`);
    }
  });

// ============================================================
// prime sync
// ============================================================
program
  .command('sync')
  .description('Refresh all connected sources')
  .action(async () => {
    const db = await getDb();
    console.log('\n⚡ Syncing...\n');

    const gmailTokens = getConfig(db, 'gmail_tokens');
    if (gmailTokens) {
      console.log('  Syncing Gmail...');
      const { threads, items } = await scanGmail(db, { days: 7, maxThreads: 50 });
      console.log(`  ✓ Gmail: ${threads} threads → ${items} new items`);
    }

    const calTokens = getConfig(db, 'calendar_tokens');
    if (calTokens) {
      console.log('  Syncing Calendar...');
      const { events, items } = await scanCalendar(db);
      console.log(`  ✓ Calendar: ${events} events → ${items} new items`);
    }

    const stats = getStats(db);
    console.log(`\n  Total knowledge: ${stats.total_items} items\n`);
  });

// ============================================================
// prime serve
// ============================================================
program
  .command('serve')
  .description('Start the Prime API + MCP server with background sync')
  .option('-p, --port <port>', 'Port number', '3210')
  .option('--no-sync', 'Disable background sync')
  .option('--sync-interval <minutes>', 'Sync interval in minutes', '15')
  .action(async (opts: any) => {
    await startServer(parseInt(opts.port) || 3210, {
      sync: opts.sync !== false,
      syncInterval: parseInt(opts.syncInterval) || 15,
    });
  });

program.parse();
