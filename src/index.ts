#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { getDb, getStats, setConfig, getConfig, searchByText, searchByEmbedding, insertKnowledge, getAllKnowledge, updateKnowledgeExtraction, type KnowledgeItem } from './db.js';
import { generateEmbedding } from './embedding.js';
import { extractIntelligence } from './ai/extract.js';
import { askWithSources } from './ai/ask.js';
import { startServer } from './server/index.js';
import { v4 as uuid } from 'uuid';
import { connectGmail, scanGmail } from './connectors/gmail.js';
import { learnBusinessContext } from './ai/learn.js';
import { refineKnowledgeBase } from './ai/refine.js';
import { buildHierarchy } from './ai/hierarchy.js';
import { getHierarchyStats, getThemes, getSemantics, getEpisodes, getConnectionStats } from './db.js';
import { getContactGraph, getConnections } from './ai/connections.js';
import { getCommitmentSummary } from './ai/commitments.js';
import { getCommitments, getCommitmentStats } from './db.js';
import { generateBriefing } from './ai/briefing.js';
import { getAlerts, generatePrep, generateCatchup, getRelationshipHealth, generateDealBrief } from './ai/intelligence.js';
import { connectCalendar, scanCalendar } from './connectors/calendar.js';
import { indexDirectory } from './connectors/files.js';
import { importClaudeConversations, connectClaude, scanClaude } from './connectors/claude.js';
import { connectOtter, scanOtter } from './connectors/otter.js';
import { connectCowork, scanCowork } from './connectors/cowork.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
    console.log('\n⚡ PRIME RECALL — The AI that already knows your business\n');

    const db = getDb();

    // Check if already initialized
    const existing = getConfig(db, 'openai_api_key');
    if (existing) {
      console.log('  ✓ Prime is already initialized.');
      const stats = getStats(db);
      console.log(`  ${stats.total_items} knowledge items indexed.`);
      console.log('\n  Run: recall status         for details');
      console.log('  Run: recall connect gmail  to add Gmail\n');
      return;
    }

    // Detect Claude Code CLI
    let hasClaudeCode = false;
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
      if (stdout.includes('Claude Code')) {
        hasClaudeCode = true;
      }
    } catch {}

    console.log('  Setting up your intelligence stack:\n');

    if (hasClaudeCode) {
      console.log('  ✓ Claude Code detected — all AI reasoning is FREE via your subscription');
      console.log('    (extraction, learning, refinement, Q&A — all powered by Claude)');
      setConfig(db, 'llm_provider', 'claude-code');
    } else {
      console.log('  ⚠ Claude Code not detected.');
      console.log('    For free AI reasoning, install Claude Code: npm install -g @anthropic-ai/claude-code');
      console.log('    Without it, Prime will use OpenAI API for reasoning (costs ~$0.01/query).\n');
      setConfig(db, 'llm_provider', 'openai');
    }

    // OpenAI key needed for embeddings regardless
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

    console.log('\n  OpenAI API key is needed for embeddings (semantic search).');
    console.log('  Cost: ~$0.02 per 1M tokens — pennies for thousands of items.\n');

    const apiKey = await ask('  OpenAI API key: ');
    if (!apiKey.startsWith('sk-')) {
      console.log('  ✗ Invalid API key. Must start with sk-');
      rl.close();
      return;
    }

    setConfig(db, 'openai_api_key', apiKey);

    // Check for Google OAuth credentials
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      console.log('\n  ✓ Google OAuth credentials found in environment');
    } else {
      console.log('\n  ⚠ To connect Gmail/Calendar, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
      console.log('    in your .env file or environment. See: README.md#google-setup');
    }

    console.log('\n  ✓ Knowledge base created at ~/.prime/prime.db');
    console.log(`  ✓ AI provider: ${hasClaudeCode ? 'Claude Code (free)' : 'OpenAI API'}`);
    console.log('  ✓ Embeddings: OpenAI text-embedding-3-small');
    console.log('\n  Next steps:');
    console.log('    recall connect gmail     Connect your email');
    console.log('    recall remember "..."    Quick capture a fact');
    console.log('    recall search "query"    Search your knowledge\n');

    rl.close();
  });

// ============================================================
// prime status
// ============================================================
program
  .command('status')
  .description('Show what Prime knows')
  .action(async () => {
    const db = getDb();
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
    const db = getDb();
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

      // Calculate age and staleness
      let dateStr = '';
      let staleWarning = '';
      if (r.source_date) {
        const date = new Date(r.source_date);
        const daysAgo = Math.floor((Date.now() - date.getTime()) / 86400000);
        dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        if (daysAgo > 30) staleWarning = ` ⚠ ${daysAgo}d old`;
        else if (daysAgo > 14) staleWarning = ` (${daysAgo}d ago)`;
        else if (daysAgo > 0) dateStr += ` (${daysAgo}d ago)`;
      }

      console.log(`  ${sim} ${r.title}${imp}`);
      console.log(`     ${r.summary}`);
      console.log(`     📎 ${r.source} | ${dateStr}${staleWarning}${r.project ? ` | 📁 ${r.project}` : ''}`);
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
    setConfig(db, 'business_context', text);
    console.log('\n  ✓ Business context saved. Prime will use this to prioritize.\n');
  });

// ============================================================
// prime connect gmail
// ============================================================
program
  .command('connect')
  .argument('<source>', 'Source to connect (gmail, calendar, claude, otter, cowork)')
  .description('Connect a data source')
  .option('--session-key <key>', 'Session key for Claude.ai (avoids Keychain/manual entry)')
  .action(async (source: string, opts: any) => {
    const db = getDb();

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

        const { threads, items } = await scanGmail(db, { days: 90, maxThreads: 500 });

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

        // Auto-learn business context from ingested data
        console.log('\n  🧠 Learning your business context...');
        try {
          const context = await learnBusinessContext(db);
          if (context) {
            console.log('  ✓ Business context auto-generated. Future extractions will be more accurate.');
          }
        } catch {
          console.log('  ⚠ Could not auto-generate business context. Use: recall context "..."');
        }

        console.log('\n  Try: recall search "who should I follow up with"');
        console.log('  Try: recall ask "what should I focus on today?"\n');
      } else {
        console.log('  ✗ Failed to connect Gmail\n');
      }
    } else if (source === 'claude') {
      console.log('\n⚡ Connecting Claude.ai...\n');
      const success = await connectClaude(db, opts.sessionKey);

      if (success) {
        console.log('\n  Scanning your Claude conversations...\n');

        const { conversations, items, artifacts, skipped } = await scanClaude(db, { days: 90, maxConversations: 200 });

        console.log(`\n  ✓ ${conversations} conversations → ${items} knowledge items (${artifacts} artifacts)`);
        if (skipped > 0) console.log(`    ${skipped} conversations skipped (already indexed or too short)`);

        const stats = getStats(db);
        console.log(`\n  Total knowledge: ${stats.total_items} items`);

        console.log('\n  Try: recall search "carefront insurance"');
        console.log('  Try: recall ask "what artifacts did I create this week?"');
        console.log('  Try: recall open "carefront"  (opens conversation in browser)\n');
      } else {
        console.log('  ✗ Failed to connect Claude.ai\n');
      }
    } else if (source === 'otter') {
      console.log('\n⚡ Connecting Otter.ai...\n');
      const success = await connectOtter(db);

      if (success) {
        console.log('\n  Scanning your Otter meetings...\n');

        const { meetings, items } = await scanOtter(db, { days: 90, maxMeetings: 200 });

        console.log(`\n  ✓ ${meetings} meetings → ${items} knowledge items`);

        const stats = getStats(db);
        console.log(`\n  Total knowledge: ${stats.total_items} items`);

        console.log('\n  Try: recall search "meeting with..."');
        console.log('  Try: recall ask "what action items came out of my last meeting?"\n');
      } else {
        console.log('  ✗ Failed to connect Otter.ai\n');
      }
    } else if (source === 'cowork') {
      console.log('\n⚡ Connecting Cowork (Claude Desktop agent mode)...\n');
      const success = await connectCowork(db);

      if (success) {
        console.log('\n  Scanning Cowork sessions...\n');
        const { sessions, items, skipped } = await scanCowork(db, { days: 90, maxSessions: 200 });

        console.log(`\n  ✓ ${sessions} sessions → ${items} knowledge items`);
        if (skipped > 0) console.log(`    ${skipped} sessions skipped (already indexed or too short)`);

        const stats = getStats(db);
        console.log(`\n  Total knowledge: ${stats.total_items} items\n`);
      } else {
        console.log('  ✗ Failed to connect Cowork\n');
      }
    } else {
      console.log(`  Unknown source: ${source}. Available: gmail, calendar, claude, otter, cowork\n`);
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
    const db = getDb();
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
    const db = getDb();
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
// prime learn
// ============================================================
program
  .command('learn')
  .description('Re-learn business context from all ingested data')
  .action(async () => {
    const db = getDb();
    console.log('\n  🧠 Learning business context from all knowledge...\n');

    try {
      const context = await learnBusinessContext(db);
      if (context) {
        console.log('  ✓ Business context generated:\n');
        // Show first 500 chars of context
        const preview = context.length > 500 ? context.substring(0, 500) + '...' : context;
        console.log(`  ${preview.replace(/\n/g, '\n  ')}\n`);
      } else {
        console.log('  ⚠ Not enough data to learn context. Add more knowledge first.\n');
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message}\n`);
    }
  });

// ============================================================
// prime refine
// ============================================================
program
  .command('refine')
  .alias('dream')
  .description('Refine the knowledge base — dedup, classify, extract, consolidate, connect (alias: dream)')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (opts: any) => {
    const db = getDb();
    console.log('\n⚡ Refining knowledge base...\n');

    try {
      const stats = await refineKnowledgeBase(db, { verbose: opts.verbose });

      console.log('\n  Refinement complete:');
      if (stats.contextUpdated) console.log('    ✓ Business context updated');
      if (stats.duplicatesMerged > 0) console.log(`    ✓ ${stats.duplicatesMerged} duplicate contacts merged`);
      if (stats.reclassified > 0) console.log(`    ✓ ${stats.reclassified} items reclassified to correct projects`);
      if (stats.staleItems > 0) console.log(`    ⚠ ${stats.staleItems} items are 30+ days old (may need refresh)`);
      if (stats.commitments?.extracted > 0) console.log(`    ✓ ${stats.commitments.extracted} commitments extracted`);
      if (stats.commitments?.newOverdue > 0) console.log(`    ⚠ ${stats.commitments.newOverdue} commitments now overdue`);
      if (stats.commitments?.newFulfilled > 0) console.log(`    ✓ ${stats.commitments.newFulfilled} commitments fulfilled`);
      if (stats.commitments?.newDropped > 0) console.log(`    ✗ ${stats.commitments.newDropped} commitments dropped`);
      if (stats.hierarchy?.themes > 0) {
        console.log(`    ✓ Hierarchy: ${stats.hierarchy.themes} themes, ${stats.hierarchy.semantics} facts, ${stats.hierarchy.episodes} episodes`);
        if (stats.hierarchy.merged > 0) console.log(`      (merged ${stats.hierarchy.merged} duplicate facts)`);
      }
      if (!stats.contextUpdated && stats.duplicatesMerged === 0 && stats.reclassified === 0 && stats.staleItems === 0 && !stats.hierarchy?.themes) {
        console.log('    ✓ Knowledge base is already clean');
      }
      console.log('');
    } catch (err: any) {
      console.error(`  Error: ${err.message}\n`);
    }
  });

// ============================================================
// prime sync
// ============================================================
program
  .command('sync')
  .description('Refresh all connected sources')
  .action(async () => {
    const db = getDb();
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

    const claudeKey = getConfig(db, 'claude_session_key');
    if (claudeKey) {
      console.log('  Syncing Claude.ai...');
      try {
        const { conversations, items, artifacts } = await scanClaude(db, { days: 7, maxConversations: 50 });
        console.log(`  ✓ Claude: ${conversations} conversations → ${items} items (${artifacts} artifacts)`);
      } catch (err: any) {
        console.log(`  ⚠ Claude sync failed: ${err.message}`);
      }
    }

    const stats = getStats(db);
    console.log(`\n  Total knowledge: ${stats.total_items} items\n`);
  });

// ============================================================
// prime serve
// ============================================================
// prime open <query>
// ============================================================
program
  .command('open <query>')
  .description('Search and open the source conversation in your browser')
  .action(async (query: string) => {
    const db = getDb();
    const apiKey = getConfig(db, 'openai_api_key');

    let results: any[];
    if (apiKey) {
      try {
        const queryEmb = await generateEmbedding(query, apiKey);
        results = searchByEmbedding(db, queryEmb, 5, 0.3);
      } catch {
        results = searchByText(db, query, 5);
      }
    } else {
      results = searchByText(db, query, 5);
    }

    // Filter to items that have openable source refs
    const openable = results.filter(r => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {});
      return meta.conversation_uuid || r.source_ref?.startsWith('claude:') || r.source_ref?.startsWith('thread:');
    });

    if (openable.length === 0) {
      console.log(`\n  No openable results for "${query}". Only Claude and Gmail conversations can be opened.\n`);
      return;
    }

    // Show matches and open the top one
    console.log(`\n  Found ${openable.length} results:\n`);
    for (let i = 0; i < openable.length; i++) {
      const r = openable[i];
      const sim = r.similarity ? ` [${(r.similarity * 100).toFixed(0)}%]` : '';
      console.log(`  ${i === 0 ? '→' : ' '} ${i + 1}.${sim} ${r.title} (${r.source})`);
    }

    const top = openable[0];
    const meta = typeof top.metadata === 'string' ? JSON.parse(top.metadata || '{}') : (top.metadata || {});

    let url = '';
    if (meta.conversation_uuid) {
      const orgId = getConfig(db, 'claude_active_org') || '';
      url = `https://claude.ai/chat/${meta.conversation_uuid}`;
    } else if (top.source_ref?.startsWith('claude:')) {
      const convoId = top.source_ref.replace('claude:', '').split(':')[0];
      url = `https://claude.ai/chat/${convoId}`;
    } else if (top.source_ref?.startsWith('thread:')) {
      const threadId = top.source_ref.replace('thread:', '');
      url = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
    }

    if (url) {
      console.log(`\n  Opening: ${url}\n`);
      const open = (await import('open')).default;
      await open(url);
    }
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

// ============================================================
// recall re-extract
// ============================================================
program
  .command('re-extract')
  .description('Re-process all knowledge items through Claude Code extraction')
  .option('-n, --dry-run', 'Show what would change without writing')
  .option('-l, --limit <n>', 'Process only first N items')
  .action(async (opts: any) => {
    const db = getDb();
    const limit = opts.limit ? parseInt(opts.limit) : undefined;
    const dryRun = opts.dryRun || false;

    const items = getAllKnowledge(db, limit);
    const total = items.length;

    if (total === 0) {
      console.log('\n  No knowledge items to re-extract.\n');
      return;
    }

    console.log(`\n⚡ Re-extracting ${total} items through Claude Code...${dryRun ? ' (DRY RUN)' : ''}\n`);

    let updated = 0;
    let errors = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const num = i + 1;
      process.stdout.write(`  [${num}/${total}] ${(item.title as string).slice(0, 60)}...`);

      try {
        // Reconstruct the original content from stored fields
        const contentParts: string[] = [];
        if (item.title) contentParts.push(`Title: ${item.title}`);
        if (item.summary) contentParts.push(`Summary: ${item.summary}`);
        if (item.metadata && typeof item.metadata === 'object') {
          // Include any raw content stored in metadata
          if (item.metadata.raw_content) contentParts.push(item.metadata.raw_content);
          if (item.metadata.body_preview) contentParts.push(item.metadata.body_preview);
          if (item.metadata.snippet) contentParts.push(item.metadata.snippet);
        }
        const content = contentParts.join('\n\n');

        const extracted = await extractIntelligence(content);

        if (dryRun) {
          // Show what would change
          const changes: string[] = [];
          const oldContacts = JSON.stringify(item.contacts || []);
          const newContacts = JSON.stringify(extracted.contacts || []);
          if (oldContacts !== newContacts) changes.push(`contacts: ${oldContacts} → ${newContacts}`);

          const oldOrgs = JSON.stringify(item.organizations || []);
          const newOrgs = JSON.stringify(extracted.organizations || []);
          if (oldOrgs !== newOrgs) changes.push(`orgs: ${oldOrgs} → ${newOrgs}`);

          const oldProject = item.project || 'null';
          const newProject = extracted.project || 'null';
          if (oldProject !== newProject) changes.push(`project: ${oldProject} → ${newProject}`);

          const oldImportance = item.importance || 'normal';
          const newImportance = extracted.importance || 'normal';
          if (oldImportance !== newImportance) changes.push(`importance: ${oldImportance} → ${newImportance}`);

          const oldDecisions = JSON.stringify(item.decisions || []);
          const newDecisions = JSON.stringify(extracted.decisions || []);
          if (oldDecisions !== newDecisions) changes.push(`decisions changed`);

          const oldCommitments = JSON.stringify(item.commitments || []);
          const newCommitments = JSON.stringify(extracted.commitments || []);
          if (oldCommitments !== newCommitments) changes.push(`commitments changed`);

          const oldActions = JSON.stringify(item.action_items || []);
          const newActions = JSON.stringify(extracted.action_items || []);
          if (oldActions !== newActions) changes.push(`action_items changed`);

          const oldTags = JSON.stringify(item.tags || []);
          const newTags = JSON.stringify(extracted.tags || []);
          if (oldTags !== newTags) changes.push(`tags changed`);

          if (changes.length > 0) {
            console.log(` WOULD CHANGE:`);
            for (const c of changes) {
              console.log(`    ${c}`);
            }
            updated++;
          } else {
            console.log(` no changes`);
          }
        } else {
          updateKnowledgeExtraction(db, item.id as string, {
            contacts: extracted.contacts,
            organizations: extracted.organizations,
            decisions: extracted.decisions,
            commitments: extracted.commitments,
            action_items: extracted.action_items,
            tags: extracted.tags,
            project: extracted.project,
            importance: extracted.importance,
          });
          updated++;
          console.log(` ✓`);
        }
      } catch (err: any) {
        errors++;
        console.log(` ✗ ${err.message}`);
      }
    }

    console.log(`\n  ${dryRun ? 'Would update' : 'Updated'}: ${updated}/${total} items`);
    if (errors > 0) console.log(`  Errors: ${errors}`);

    if (!dryRun && updated > 0) {
      console.log('\n  🧠 Updating business context...');
      try {
        await learnBusinessContext(db);
        console.log('  ✓ Business context updated.');
      } catch {
        console.log('  ⚠ Could not update business context.');
      }
    }

    console.log('');
  });

// ============================================================
// recall hierarchy
// ============================================================
program
  .command('hierarchy')
  .description('Show the knowledge hierarchy — themes, semantic facts, episodes')
  .option('-v, --verbose', 'Show detailed theme contents')
  .option('--build', 'Force rebuild the hierarchy now')
  .action(async (opts: any) => {
    const db = getDb();

    if (opts.build) {
      console.log('\n  Building knowledge hierarchy...\n');
      try {
        const result = await buildHierarchy(db, { verbose: true });
        console.log(`\n  Hierarchy built: ${result.episodes} episodes, ${result.semantics} facts, ${result.themes} themes`);
        if (result.merged > 0) console.log(`  Merged ${result.merged} duplicate facts`);
        if (result.split > 0) console.log(`  Split ${result.split} large themes`);
        console.log('');
      } catch (err: any) {
        console.error(`  Error building hierarchy: ${err.message}\n`);
        return;
      }
    }

    const hStats = getHierarchyStats(db);

    console.log('\n  Knowledge Hierarchy:');
    console.log(`    Themes: ${hStats.themes}`);
    console.log(`    Semantic Facts: ${hStats.semantics}`);
    console.log(`    Episodes: ${hStats.episodes}`);
    console.log(`    Raw Items: ${hStats.items}`);

    if (hStats.themes === 0) {
      console.log('\n  No hierarchy built yet. Run: recall refine  or  recall hierarchy --build\n');
      return;
    }

    const themes = getThemes(db);
    if (themes.length > 0) {
      console.log('\n  Themes:');
      for (const theme of themes) {
        const semanticIds = Array.isArray(theme.semantic_ids) ? theme.semantic_ids : [];
        // Count unique episodes from member semantics
        const themSemantics = getSemantics(db).filter(s => semanticIds.includes(s.id));
        const episodeSet = new Set<string>();
        for (const s of themSemantics) {
          const eids = Array.isArray(s.episode_ids) ? s.episode_ids : [];
          for (const eid of eids) episodeSet.add(eid);
        }
        console.log(`    ${theme.name} (${semanticIds.length} facts, ${episodeSet.size} episodes)`);
        if (theme.description) console.log(`      ${theme.description}`);

        if (opts.verbose) {
          for (const sem of themSemantics.slice(0, 5)) {
            console.log(`        [${sem.fact_type}] ${sem.fact}`);
          }
          if (themSemantics.length > 5) {
            console.log(`        ... and ${themSemantics.length - 5} more`);
          }
        }
      }
    }

    console.log('');
  });

// ============================================================
// recall connections <query>
// ============================================================
program
  .command('connections <query>')
  .description('Show connections graph for a contact or knowledge item')
  .option('-d, --depth <n>', 'Graph traversal depth', '2')
  .action(async (query: string, opts: any) => {
    const db = getDb();
    const depth = parseInt(opts.depth) || 2;

    // First, try to find as a contact
    const allItems = searchByText(db, '', 1000);
    const contactCounts = new Map<string, number>();
    for (const item of allItems) {
      const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
      for (const name of contacts) {
        contactCounts.set(name, (contactCounts.get(name) || 0) + 1);
      }
    }

    // Match contact by name (case-insensitive partial match)
    const queryLower = query.toLowerCase().trim();
    const matchedContact = Array.from(contactCounts.keys()).find(
      c => c.toLowerCase().includes(queryLower)
    );

    if (matchedContact) {
      // Contact mode — show contact graph
      const graph = getContactGraph(db, matchedContact);

      console.log(`\n⚡ Connections for "${matchedContact}":\n`);

      if (graph.directItems.length > 0) {
        console.log(`  Direct (${graph.directItems.length} items):`);
        for (const item of graph.directItems.slice(0, 15)) {
          const dateStr = item.source_date
            ? new Date(item.source_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
          console.log(`    ${item.title} (${item.source}${dateStr ? ', ' + dateStr : ''})`);
        }
        if (graph.directItems.length > 15) {
          console.log(`    ... and ${graph.directItems.length - 15} more`);
        }
      }

      if (graph.connectedItems.length > 0) {
        console.log(`\n  Connected via mentions (${graph.connectedItems.length} items):`);
        for (const item of graph.connectedItems.slice(0, 10)) {
          const via = item._via || 'connection';
          console.log(`    → ${item.title} (${via})`);
        }
        if (graph.connectedItems.length > 10) {
          console.log(`    ... and ${graph.connectedItems.length - 10} more`);
        }
      }

      if (graph.projects.length > 0) {
        console.log(`\n  Projects: ${graph.projects.join(', ')}`);
      }
      if (graph.relationships.length > 0) {
        console.log(`  Relationships: ${graph.relationships.map(r => `${r.type} (${r.count})`).join(', ')}`);
      }
      console.log('');
    } else {
      // Item mode — search for best matching item and show its connections
      const results = searchByText(db, query, 1);
      if (results.length === 0) {
        console.log(`\n  No results for "${query}"\n`);
        return;
      }

      const item = results[0];
      const connections = getConnections(db, item.id, depth);

      console.log(`\n⚡ Connections for "${item.title}":\n`);

      if (connections.length === 0) {
        console.log('  No connections found. Run: recall refine  to build connections.\n');
        return;
      }

      // Group by depth
      const byDepth = new Map<number, typeof connections>();
      for (const conn of connections) {
        const group = byDepth.get(conn.depth) || [];
        group.push(conn);
        byDepth.set(conn.depth, group);
      }

      for (const [d, conns] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
        const label = d === 1 ? 'Direct connections' : `${d}-hop connections`;
        console.log(`  ${label} (${conns.length}):`);
        for (const conn of conns.slice(0, 10)) {
          const conf = conn.confidence < 1 ? ` [${(conn.confidence * 100).toFixed(0)}%]` : '';
          console.log(`    [${conn.relationship}${conf}] ${conn.item.title}`);
        }
        if (conns.length > 10) {
          console.log(`    ... and ${conns.length - 10} more`);
        }
      }

      // Show relationship summary
      const relCounts = new Map<string, number>();
      for (const conn of connections) {
        relCounts.set(conn.relationship, (relCounts.get(conn.relationship) || 0) + 1);
      }
      console.log(`\n  Relationships: ${Array.from(relCounts.entries()).map(([r, c]) => `${r} (${c})`).join(', ')}`);
      console.log('');
    }
  });

// ============================================================
// recall commitments
// ============================================================
program
  .command('commitments')
  .description('Show all commitments grouped by state')
  .option('--overdue', 'Show only overdue commitments')
  .option('-p, --project <project>', 'Filter by project')
  .option('-s, --state <state>', 'Filter by state (detected, active, fulfilled, overdue, dropped)')
  .action(async (opts: any) => {
    const db = getDb();

    // If specific filters requested, use getCommitments directly
    if (opts.overdue || opts.state || opts.project) {
      const commitments = opts.overdue
        ? getCommitments(db, { overdue: true })
        : getCommitments(db, { state: opts.state, project: opts.project });

      if (commitments.length === 0) {
        console.log('\n  No commitments match your filter.\n');
        return;
      }

      console.log(`\n  Commitments (${commitments.length}):\n`);
      for (const c of commitments) {
        const due = c.due_date ? ` (due ${new Date(c.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : '';
        console.log(`    "${c.text}"${due}`);
        const parts: string[] = [];
        if (c.project) parts.push(`Project: ${c.project}`);
        if (c.owner) parts.push(`Owner: ${c.owner}`);
        if (c.context) parts.push(`From: ${c.context}`);
        if (parts.length > 0) console.log(`      ${parts.join(' | ')}`);
      }
      console.log('');
      return;
    }

    // Full summary view
    const summary = getCommitmentSummary(db);
    const stats = getCommitmentStats(db);

    if (stats.total === 0) {
      console.log('\n  No commitments tracked yet. Run: recall refine  to extract commitments.\n');
      return;
    }

    console.log('\n  Commitments:\n');

    const now = new Date();

    if (summary.fires.length > 0) {
      console.log(`    OVERDUE (${summary.fires.length}):`);
      for (const c of summary.fires) {
        const dueStr = c.due_date
          ? new Date(c.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'no date';
        console.log(`      "${c.text}" -- ${c.days_overdue} days overdue (due ${dueStr})`);
        const parts: string[] = [];
        if (c.project) parts.push(`Project: ${c.project}`);
        if (c.context) parts.push(`From: ${c.context}`);
        if (parts.length > 0) console.log(`        ${parts.join(' | ')}`);
      }
      console.log('');
    }

    if (summary.due_soon.length > 0) {
      console.log(`    DUE SOON (${summary.due_soon.length}):`);
      for (const c of summary.due_soon) {
        const dueDate = new Date(c.due_date);
        const daysUntil = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
        const dueLabel = daysUntil <= 0 ? 'due today' : daysUntil === 1 ? 'due tomorrow' : `due in ${daysUntil} days`;
        const dateStr = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        console.log(`      "${c.text}" -- ${dueLabel} (${dateStr})`);
        const parts: string[] = [];
        if (c.owner) parts.push(`Owner: ${c.owner}`);
        if (c.project) parts.push(`Project: ${c.project}`);
        if (parts.length > 0) console.log(`        ${parts.join(' | ')}`);
      }
      console.log('');
    }

    if (summary.active.length > 0) {
      console.log(`    ACTIVE (${summary.active.length}):`);
      for (const c of summary.active.slice(0, 15)) {
        const due = c.due_date
          ? ` (due ${new Date(c.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
          : '';
        console.log(`      "${c.text}"${due}`);
        const parts: string[] = [];
        if (c.project) parts.push(`Project: ${c.project}`);
        if (c.owner) parts.push(`Owner: ${c.owner}`);
        if (parts.length > 0) console.log(`        ${parts.join(' | ')}`);
      }
      if (summary.active.length > 15) console.log(`      ... and ${summary.active.length - 15} more`);
      console.log('');
    }

    if (summary.recently_fulfilled.length > 0) {
      console.log(`    RECENTLY FULFILLED (${summary.recently_fulfilled.length}):`);
      for (const c of summary.recently_fulfilled) {
        console.log(`      "${c.text}"`);
      }
      console.log('');
    }

    if (summary.dropped.length > 0) {
      console.log(`    DROPPED (${summary.dropped.length}):`);
      for (const c of summary.dropped.slice(0, 5)) {
        console.log(`      "${c.text}"`);
      }
      if (summary.dropped.length > 5) console.log(`      ... and ${summary.dropped.length - 5} more`);
      console.log('');
    }

    // Stats summary
    const detected = stats.byState['detected'] || 0;
    if (detected > 0) {
      console.log(`    ${detected} detected commitments awaiting activation.\n`);
    }
  });

// ============================================================
// recall briefing
// ============================================================
program
  .command('briefing')
  .description('Generate your daily intelligence briefing')
  .option('--no-save', 'Generate but don\'t save to knowledge base')
  .option('--days <n>', 'Look back N days instead of default 7', '7')
  .action(async (opts: any) => {
    const db = getDb();
    const days = parseInt(opts.days) || 7;
    const save = opts.save !== false;

    console.log('\n  \u26A1 Generating your morning briefing...\n');

    try {
      const result = await generateBriefing(db, { days, save });

      const dateHeader = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      console.log('\u2501'.repeat(50));
      console.log(`  DAILY BRIEFING \u2014 ${dateHeader}`);
      console.log('\u2501'.repeat(50));
      console.log('');
      console.log(`  ${result.briefing.replace(/\n/g, '\n  ')}`);
      console.log('');
      console.log('\u2501'.repeat(50));
      const saveNote = save ? 'Briefing saved.' : 'Briefing not saved (--no-save).';
      console.log(`  ${saveNote} Sources: ${result.meta.itemsAnalyzed} items analyzed.`);
      if (result.meta.droppedBalls > 0) console.log(`  Dropped balls: ${result.meta.droppedBalls}`);
      if (result.meta.coldRelationships > 0) console.log(`  Cold relationships: ${result.meta.coldRelationships}`);
      if (result.meta.activeCommitments > 0) console.log(`  Active commitments: ${result.meta.activeCommitments}`);
      if (result.meta.calendarEvents > 0) console.log(`  Calendar events: ${result.meta.calendarEvents}`);
      console.log('');
    } catch (err: any) {
      console.error(`  Error: ${err.message}\n`);
    }
  });

// ============================================================
// recall fix <query> — manually correct a knowledge item
// ============================================================
program
  .command('fix <query>')
  .description('Manually correct a knowledge item — reassign project, contacts, importance')
  .option('-p, --project <project>', 'Set project')
  .option('-i, --importance <level>', 'Set importance (low/normal/high/critical)')
  .option('--add-contact <name>', 'Add a contact')
  .option('--remove-contact <name>', 'Remove a contact')
  .option('--add-tag <tag>', 'Add a tag')
  .option('--remove-tag <tag>', 'Remove a tag')
  .option('--re-extract', 'Re-run AI extraction on this item')
  .action(async (query: string, opts: any) => {
    const db = getDb();

    // Find the item
    const results = searchByText(db, query, 5);
    if (results.length === 0) {
      console.log(`\n  No items matching "${query}"\n`);
      return;
    }

    // Show matches and pick the best one
    const item = results[0];
    console.log(`\n  Fixing: "${item.title}"`);
    console.log(`    Current project: ${item.project || '(none)'}`);
    console.log(`    Current importance: ${item.importance || 'normal'}`);

    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    const tags = Array.isArray(item.tags) ? item.tags : JSON.parse(item.tags || '[]');
    console.log(`    Contacts: ${contacts.join(', ') || '(none)'}`);
    console.log(`    Tags: ${tags.join(', ') || '(none)'}`);

    const updates: string[] = [];
    const params: any[] = [];

    if (opts.project) {
      updates.push('project = ?');
      params.push(opts.project);
      console.log(`    → Project: ${item.project || '(none)'} → ${opts.project}`);
    }

    if (opts.importance) {
      updates.push('importance = ?');
      params.push(opts.importance);
      console.log(`    → Importance: ${item.importance} → ${opts.importance}`);
    }

    if (opts.addContact) {
      if (!contacts.includes(opts.addContact)) contacts.push(opts.addContact);
      updates.push('contacts = ?');
      params.push(JSON.stringify(contacts));
      console.log(`    → Added contact: ${opts.addContact}`);
    }

    if (opts.removeContact) {
      const idx = contacts.indexOf(opts.removeContact);
      if (idx >= 0) contacts.splice(idx, 1);
      updates.push('contacts = ?');
      params.push(JSON.stringify(contacts));
      console.log(`    → Removed contact: ${opts.removeContact}`);
    }

    if (opts.addTag) {
      if (!tags.includes(opts.addTag)) tags.push(opts.addTag);
      updates.push('tags = ?');
      params.push(JSON.stringify(tags));
      console.log(`    → Added tag: ${opts.addTag}`);
    }

    if (opts.removeTag) {
      const idx = tags.indexOf(opts.removeTag);
      if (idx >= 0) tags.splice(idx, 1);
      updates.push('tags = ?');
      params.push(JSON.stringify(tags));
      console.log(`    → Removed tag: ${opts.removeTag}`);
    }

    if (opts.reExtract) {
      console.log(`    → Re-extracting with Claude...`);
      const content = `Title: ${item.title}\nSummary: ${item.summary}`;
      const extracted = await extractIntelligence(content);
      updateKnowledgeExtraction(db, item.id, {
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: extracted.tags,
        project: opts.project || extracted.project, // manual project overrides AI
        importance: opts.importance || extracted.importance,
      });
      console.log(`    ✓ Re-extracted`);
    } else if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(item.id);
      db.prepare(`UPDATE knowledge SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    if (updates.length === 0 && !opts.reExtract) {
      console.log('\n  No changes specified. Use --project, --importance, --add-contact, --remove-contact, --add-tag, --remove-tag, or --re-extract\n');
      return;
    }

    console.log('  ✓ Fixed.\n');
  });

// ============================================================
// prime alerts
// ============================================================
program
  .command('alerts')
  .description('What needs your attention RIGHT NOW — dropped balls, overdue commitments, cold relationships')
  .action(async () => {
    const db = getDb();
    const alerts = getAlerts(db);

    if (alerts.length === 0) {
      console.log('\n  ✓ All clear. No urgent alerts.\n');
      return;
    }

    console.log(`\n⚠️  ${alerts.length} ALERTS\n`);

    const icons = {
      dropped_ball: '🔴',
      overdue_commitment: '🟠',
      deadline_approaching: '🟡',
      cold_relationship: '🔵',
    };

    const severityLabel = {
      critical: ' [CRITICAL]',
      high: ' [HIGH]',
      normal: '',
    };

    for (const alert of alerts) {
      console.log(`  ${icons[alert.type]}${severityLabel[alert.severity]} ${alert.title}`);
      console.log(`     ${alert.detail}`);
      if (alert.project) console.log(`     📁 ${alert.project}`);
      console.log('');
    }
  });

// ============================================================
// prime prep <person or topic>
// ============================================================
program
  .command('prep <query>')
  .description('Intelligence dossier on a person, topic, or upcoming meeting')
  .action(async (query: string) => {
    const db = getDb();
    console.log(`\n⚡ Generating intelligence prep for "${query}"...\n`);
    const result = await generatePrep(db, query);
    console.log(result);
    console.log('');
  });

// ============================================================
// prime catchup
// ============================================================
program
  .command('catchup')
  .description('What happened while you were away')
  .option('-d, --days <n>', 'Days to catch up on', '3')
  .action(async (opts: any) => {
    const db = getDb();
    const days = parseInt(opts.days) || 3;
    console.log(`\n⚡ Catching you up on the last ${days} days...\n`);
    const result = await generateCatchup(db, { days });
    console.log(result);
    console.log('');
  });

// ============================================================
// prime relationships
// ============================================================
program
  .command('relationships')
  .description('Relationship health dashboard — who\'s active, warm, cooling, cold')
  .option('--cold', 'Show only cold/dormant contacts')
  .action(async (opts: any) => {
    const db = getDb();
    let contacts = getRelationshipHealth(db);

    if (opts.cold) {
      contacts = contacts.filter(c => c.status === 'cold' || c.status === 'dormant');
    }

    if (contacts.length === 0) {
      console.log('\n  No contacts tracked yet.\n');
      return;
    }

    console.log('\n⚡ RELATIONSHIP HEALTH\n');

    const statusIcons: Record<string, string> = {
      active: '🟢', warm: '🟡', cooling: '🟠', cold: '🔴', dormant: '⚫',
    };

    // Group by status
    const groups = ['active', 'warm', 'cooling', 'cold', 'dormant'] as const;
    for (const status of groups) {
      const group = contacts.filter(c => c.status === status);
      if (group.length === 0) continue;

      console.log(`  ${statusIcons[status]} ${status.toUpperCase()} (${group.length}):`);
      for (const c of group.slice(0, 10)) {
        const sources = c.sources.join(', ');
        const projects = c.projects.length > 0 ? ` | ${c.projects.join(', ')}` : '';
        console.log(`     ${c.name} — ${c.daysSince}d ago (${c.mentions} mentions, ${sources}${projects})`);
      }
      if (group.length > 10) console.log(`     ... +${group.length - 10} more`);
      console.log('');
    }
  });

// ============================================================
// prime deal <project>
// ============================================================
program
  .command('deal <project>')
  .description('Deal intelligence dossier — everything about a project/deal')
  .action(async (project: string) => {
    const db = getDb();
    console.log(`\n⚡ Generating deal intelligence for "${project}"...\n`);
    const result = await generateDealBrief(db, project);
    console.log(result);
    console.log('');
  });

// ============================================================
// prime setup desktop
// ============================================================
program
  .command('setup')
  .argument('<target>', 'What to set up (desktop)')
  .description('Auto-configure Claude Desktop with Prime Recall MCP server + permissions')
  .action(async (target: string) => {
    if (target !== 'desktop') {
      console.log(`  Unknown target: ${target}. Available: desktop\n`);
      return;
    }

    const db = getDb();
    const { existsSync, readFileSync, writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir, platform } = await import('os');

    console.log('\n⚡ Setting up Claude Desktop integration...\n');

    // ── Step 1: Find and update claude_desktop_config.json ──
    const configPaths: Record<string, string> = {
      darwin: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      win32: join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
      linux: join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
    };

    const configPath = configPaths[platform()] || configPaths.linux;

    // Find the tsx binary path relative to this package
    const { resolve } = await import('path');
    const tsxPath = resolve(join(import.meta.dirname || '.', '..', 'node_modules', '.bin', 'tsx'));
    const mcpPath = resolve(join(import.meta.dirname || '.', 'server', 'mcp.ts'));

    // Check if tsx exists at the resolved path, fall back to global
    const { execSync } = await import('child_process');
    let tsxBin = tsxPath;
    if (!existsSync(tsxBin)) {
      try {
        tsxBin = execSync('which tsx', { encoding: 'utf-8' }).trim();
      } catch {
        tsxBin = 'npx';
      }
    }

    const allTools = [
      'prime_search', 'prime_ask', 'prime_remember',
      'prime_get_contacts', 'prime_get_commitments', 'prime_get_projects',
      'prime_get_connections', 'prime_status', 'prime_briefing',
      'prime_alerts', 'prime_prep', 'prime_catchup',
      'prime_relationships', 'prime_deal',
    ];

    let config: any = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
        console.log('  ✓ Found existing Claude Desktop config');
      } catch {
        config = {};
      }
    } else {
      console.log('  Creating new Claude Desktop config');
    }

    // Ensure structure
    if (!config.mcpServers) config.mcpServers = {};

    // Add/update prime-recall MCP server
    const mcpArgs = tsxBin === 'npx' ? ['tsx', mcpPath] : [mcpPath];
    config.mcpServers['prime-recall'] = {
      command: tsxBin === 'npx' ? 'npx' : tsxBin,
      args: mcpArgs,
      env: {
        HOME: homedir(),
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      },
      autoApprove: allTools,
    };

    // Write config
    const configDir = join(configPath, '..');
    if (!existsSync(configDir)) {
      const { mkdirSync } = await import('fs');
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  ✓ MCP server configured with auto-approve for all Prime Recall tools');
    console.log(`    Config: ${configPath}`);

    // ── Step 2: Update conversation_preferences via claude.ai API ──
    const sessionKey = getConfig(db, 'claude_session_key');

    if (sessionKey) {
      console.log('\n  Updating claude.ai conversation preferences...');

      const PRIME_SECTION = `

PRIME RECALL — UNIFIED BUSINESS KNOWLEDGE BASE
You have access to Prime Recall via MCP tools. It contains ALL of the user's emails, Claude conversations (every project, every org), meeting notes, contacts, commitments, and decisions — unified and searchable.

MANDATORY BEHAVIOR:
- Before answering ANY question about the user's business, contacts, deals, projects, people, or prior conversations: call prime_search first
- When asked about priorities or what needs attention: call prime_alerts
- When a specific person or upcoming meeting is mentioned: call prime_prep with their name
- When asked about a deal or project status: call prime_deal with the project name
- When asked for a briefing or "what's my day": call prime_briefing
- When asked to "catch me up" or "what did I miss": call prime_catchup
- When asked about follow-ups or relationships going cold: call prime_relationships
- To save new information from the conversation: call prime_remember

Do NOT answer from memory or general knowledge when Prime Recall has the data. Search first, then respond grounded in real sources.`;

      try {
        const { request: httpsRequest } = await import('https');
        const { gunzipSync } = await import('zlib');

        // GET current profile
        const getProfile = (): Promise<any> => new Promise((resolve, reject) => {
          const url = new URL('https://claude.ai/api/account_profile');
          const req = httpsRequest({
            hostname: url.hostname, path: url.pathname, method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
              'Accept': 'application/json', 'Accept-Encoding': 'gzip',
              'Cookie': `sessionKey=${sessionKey}`,
            },
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              let data = Buffer.concat(chunks);
              if (res.headers['content-encoding'] === 'gzip') data = gunzipSync(data);
              resolve(JSON.parse(data.toString()));
            });
          });
          req.on('error', reject);
          req.end();
        });

        // PUT updated profile
        const putProfile = (prefs: string): Promise<number> => new Promise((resolve, reject) => {
          const body = JSON.stringify({ conversation_preferences: prefs });
          const url = new URL('https://claude.ai/api/account_profile');
          const req = httpsRequest({
            hostname: url.hostname, path: url.pathname, method: 'PUT',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
              'Accept': 'application/json', 'Content-Type': 'application/json',
              'Cookie': `sessionKey=${sessionKey}`,
            },
          }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode || 0));
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });

        const profile = await getProfile();
        const currentPrefs = profile.conversation_preferences || '';

        if (currentPrefs.includes('PRIME RECALL')) {
          console.log('  ✓ Prime Recall instructions already in conversation preferences');
        } else {
          const status = await putProfile(currentPrefs + PRIME_SECTION);
          if (status === 200) {
            console.log('  ✓ Conversation preferences updated — Prime Recall instructions added');
            console.log('    Applies to ALL Claude Desktop and claude.ai conversations');
          } else {
            console.log(`  ⚠ Failed to update preferences (HTTP ${status}). You can add manually in claude.ai Settings > Profile.`);
          }
        }
      } catch (err: any) {
        console.log(`  ⚠ Could not update claude.ai preferences: ${err.message}`);
        console.log('    Run: recall connect claude   first, then try again');
      }
    } else {
      console.log('\n  ⚠ No Claude session key saved — skipping conversation preferences update.');
      console.log('    Run: recall connect claude   first, then: recall setup desktop');
    }

    console.log('\n  ────────────────────────────────────');
    console.log('  ✓ Setup complete!');
    console.log('  → Restart Claude Desktop to activate');
    console.log('  → All Prime Recall tools will run without permission prompts');
    console.log('  → Claude will automatically search your knowledge base\n');
  });

program.parse();
