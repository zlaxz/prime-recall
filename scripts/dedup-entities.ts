/**
 * Entity Deduplication Script
 *
 * Finds and merges duplicate entities in Prime's knowledge base.
 * Conservative: only merges when clearly the same entity.
 *
 * Strategy:
 * 1. Email-based matches: entity whose canonical_name is just an email matches
 *    another entity with that email or matching name
 * 2. First-name-only matches: "Forrest" merges into "Forrest Pullen" if there's
 *    only one entity with that first name
 * 3. Explicit merge groups for known duplicates (companies, people with variants)
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const db = new Database(process.env.HOME + '/.prime/prime.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

interface Entity {
  id: string;
  canonical_name: string;
  type: string;
  email: string | null;
  user_label: string | null;
  user_dismissed: number;
}

interface MergeAction {
  keep: Entity;
  remove: Entity[];
  reason: string;
}

// ── Explicit merge groups ──────────────────────────────────────────
// Each group: [preferred canonical name, ...all names that should merge into it]
// The entity with the most mentions OR the most complete name wins as "keep".

const PERSON_MERGE_GROUPS: string[][] = [
  // Zach variants (keep "Zach Stock")
  ['Zach Stock', 'Zach', 'Zachary', 'Zachary Stock', 'zach.stock@recaptureinsurance.com', 'zlaxz', 'zstock@stockinsgroup.com'],

  // Key contacts - first name only → full name
  ['Forrest Pullen', 'Forrest'],
  ['Dan Gilhooly', 'Dan', 'dan_gilhooly@ajg.com'],
  ['Dale Dupree', 'Dale'],
  ['Denny Kuruvilla', 'Denny', 'denny.kuruvilla@konduitcapacity.com'],
  ['Austin Elkin', 'Austin'],
  ['Kendl McKellar', 'Kendl'],
  ['Derek Chapman', 'Derek'],
  ['Costas Manganiotis', 'costas@foresitehealthcare.com'],
  ['Mark Schmidt', 'mark.schmidt@foresitehealthcare.com'],
  ['George Chronis', 'George', 'george@foresitehealthcare.com'],
  ['Luke Porter', 'Luke Billiot'],  // Luke Billiot is Luke Porter per memory (actually different people — SKIP)
  ['Skylar Shull', 'Skylar'],
  ['Stacy Haupt', 'Stacy'],
  ['Lisa Tokuyama', 'Lisa'],
  ['Sujan Patel', 'Sujan', 'Sujan from Mailshake'],
  ['Scott Keplinger', 'S. Keplinger'],
  ['Josh May', 'Josh', 'josh@condormay.com', 'Josh (Condor May)'],
  ['Adam May', 'adam@condormay.com'],
  ['Patrick Soh', 'patrick.soh@sagehealth.com'],
  ['Isabel Eiserman', 'isabel.eiserman@foresitehealthcare.com'],

  // Laura J Schultz variants
  ['Laura J. Schultz', 'Laura J Schultz'],

  // BI Events variants
  ['BI EVENTS TEAM', 'BI Events'],

  // Philip Seibel variants
  ['Philip Seibel', 'Phil Seibel'],

  // Izzie/Izzy (likely same person)
  ['Izzy', 'Izzie'],

  // Kim Coughlin / Kimberly Coughlin
  ['Kimberly Coughlin', 'Kim Coughlin'],

  // Q4intelligence variants (with trailing space)
  ['Q4intelligence', 'Q4intelligence '],

  // Lombardo, Lindsey → keep as-is, but note it's a person
];

const ORG_MERGE_GROUPS: string[][] = [
  // Recapture Insurance variants (keep most-mentioned)
  ['Recapture Insurance Services', 'Recapture Insurance', 'Recapture Insurance Services, Inc.',
   'Recapture Insurance Services, LLC', 'ReCapture', 'recaptureinsurance.com'],

  // McGill Partners variants
  ['McGill and Partners', 'McGill', 'McGill Partners', 'McGill and Partners Ltd'],

  // Bishop Street variants
  ['Bishop Street Underwriters', 'Bishop Street Program Managers', 'Bishop Street UW', 'Bishop Street Underwriting'],

  // Gallagher variants (Arthur J. Gallagher is the parent; Gallagher Healthcare/Bassett are divisions — merge cautiously)
  ['Arthur J. Gallagher', 'Gallagher', 'Gallagher Bassett', 'Gallagher Healthcare'],

  // Foresite Healthcare variants
  ['Foresite Healthcare', 'Foresight Healthcare'],

  // Claymore Capital variants
  ['Claymore Capital Advisors', 'Claymore Capital', 'Claymore Capital / Claymore Advisory', 'Claymore Capital Group'],

  // Rockwood variants
  ['Rockwood Programs, Inc.', 'Rockwood', 'Rockwood Insurance', 'Rockwood Programs'],

  // Oxford Risk Management Group variants
  ['Oxford Risk Management Group', 'Oxford', 'Oxford Risk Management Group LLC', 'Oxford RMG'],

  // Konduit variants
  ['Konduit Capacity', 'Konduit', 'konduitcapacity.com'],

  // Blenheim variants
  ['Blenheim Underwriting Limited', 'Blenheim', 'blenheim.co'],

  // Stock Insurance Group variants
  ['Stock Insurance Group', 'Stock Insurance Group Inc'],

  // Alliance Insurance Group
  ['Alliance Insurance Group', 'Alliance'],

  // Bob Behrends Roofing variants
  ['Bob Behrends Roofing, Inc.', 'Bob Behrends Roofing',
   'Bob Behrends Roofing Inc.- Metal Masters',
   'Bob Behrends Roofing, Inc DBA Bob Behrends Roofing-Commercial Division, LLC'],

  // Bridge Specialty Group
  ['Bridge Specialty Group', 'Bridge Specialty', 'Bridge'],

  // Burand Associates
  ['Burand & Associates, LLC', 'Burand Associates', 'burand-associates.com'],

  // CMS variants
  ['CMS (Centers for Medicare & Medicaid Services)', 'CMS'],

  // Addition variants
  ['Addition', 'Addition VC', 'addition.com'],

  // AT&T variants
  ['AT&T', 'AT&T Business'],

  // Artbeak variants
  ['Artbeak Agency', 'Artbeak'],

  // BrightPro variants
  ['BrightPro', 'Bright Pro'],

  // Cascade CPA variants
  ['Cascade CPA', 'Cascade/Kollath CPA', 'cascadecpa.com'],

  // Chase Bank variants
  ['Chase Bank', 'Chase', 'Chase Private Client'],

  // Hiscox variants
  ['Hiscox', 'Hiscox Inc.', 'Hiscox Insurance Company Inc'],

  // HUB International variants
  ['Hub International', 'Hub International Northeast Limited', 'HUB International Sav', 'HUB NE', 'HUB Texas'],

  // Hull & Company variants
  ['Hull & Company', 'Hull & Company/Denton'],

  // K&B variants
  ['K&B Specialty', 'K&B', 'K&B Underwriters', 'K&B/CareAgents'],

  // Liberty Company variants
  ['The Liberty Company Insurance Brokers', 'The Liberty Company', 'Liberty Company'],

  // Manchester Story variants
  ['ManchesterStory', 'Manchester Story'],

  // McGill (already covered above)

  // McKnight's variants
  ["McKnight's Senior Living", "McKnight's"],

  // Med Pro / Medpro
  ['Medpro', 'Med Pro'],

  // Mineral variants
  ['Mineral', 'Mineral, Inc.'],

  // Oakbridge variants
  ['Oakbridge Insurance', 'Oakbridge'],

  // Omega Healthcare variants
  ['Omega Healthcare Investors', 'Omega Healthcare'],

  // Sentry West variants
  ['Sentry West Insurance', 'Sentry West', 'SentryWest Insurance', 'sentrywest.com'],

  // SIGMA Actuarial variants
  ['SIGMA Actuarial Consulting Group, Inc.', 'SIGMA Actuarial', 'Sigma Actuary'],

  // SuccessRise variants
  ['SuccessRise', 'Success Rise'],

  // EveryBrain AI Studio variants
  ['EveryBrain AI Studio', 'Every Brain AI Studio'],

  // FiboInception variants
  ['FiboInception', 'Fibo Inception'],

  // Carefront variants
  ['carefrontinsurance.com', 'carefrontins.com'],

  // A Benefits Solutions
  ['A Benefit Solutions', 'A Benefits Solutions'],

  // Apcspecialistllc → APC Specialist LLC
  ['APC Specialist LLC', 'Apcspecialistllc'],
];

// ── Helper functions ───────────────────────────────────────────────

function getEntityByName(name: string, type?: string): Entity | null {
  const query = type
    ? `SELECT id, canonical_name, type, email, user_label, user_dismissed FROM entities WHERE canonical_name = ? AND type = ?`
    : `SELECT id, canonical_name, type, email, user_label, user_dismissed FROM entities WHERE canonical_name = ?`;
  const params = type ? [name, type] : [name];
  return db.prepare(query).get(...params) as Entity | null;
}

function getMentionCount(entityId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE entity_id = ?').get(entityId) as any;
  return row?.cnt ?? 0;
}

function getAliasCount(entityId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM entity_aliases WHERE entity_id = ?').get(entityId) as any;
  return row?.cnt ?? 0;
}

// ── Merge logic ────────────────────────────────────────────────────

function buildMergeActions(groups: string[][], entityType: string): MergeAction[] {
  const actions: MergeAction[] = [];

  for (const group of groups) {
    const entities: Entity[] = [];

    for (const name of group) {
      const entity = getEntityByName(name, entityType);
      if (entity) entities.push(entity);
    }

    if (entities.length < 2) continue; // Nothing to merge

    // Pick the "keep" entity: most mentions wins (it has the most FK references)
    entities.sort((a, b) => {
      const aMentions = getMentionCount(a.id);
      const bMentions = getMentionCount(b.id);
      if (aMentions !== bMentions) return bMentions - aMentions;
      // Tie-break: user-labeled entities win
      if (a.user_label && !b.user_label) return -1;
      if (!a.user_label && b.user_label) return 1;
      // Tie-break: longer canonical name
      return b.canonical_name.length - a.canonical_name.length;
    });

    const keep = entities[0];
    const remove = entities.slice(1);

    // The first entry in the group is the preferred canonical name.
    // We'll rename the kept entity to that name after merge.
    const preferredName = group[0];

    actions.push({
      keep,
      remove,
      reason: `Merge group: ${group.join(', ')}`,
      // Store preferred name for renaming
    } as MergeAction & { preferredName?: string });

    // Attach preferred name
    (actions[actions.length - 1] as any).preferredName = preferredName;
  }

  return actions;
}

function executeMerge(action: MergeAction & { preferredName?: string }, dryRun: boolean): { merged: number; mentionsMoved: number; aliasesMoved: number } {
  const keepId = action.keep.id;
  const preferredName = (action as any).preferredName || action.keep.canonical_name;
  let mentionsMoved = 0;
  let aliasesMoved = 0;

  if (dryRun) {
    for (const dup of action.remove) {
      mentionsMoved += getMentionCount(dup.id);
      aliasesMoved += getAliasCount(dup.id);
    }
    return { merged: action.remove.length, mentionsMoved, aliasesMoved };
  }

  const mergeOne = db.transaction((dupEntity: Entity) => {
    const dupId = dupEntity.id;

    // 1. Move entity_mentions from dup → keep (skip conflicts via INSERT OR IGNORE)
    const moveResult = db.prepare(`
      INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date, created_at, source_account)
      SELECT '${randomUUID()}', ?, knowledge_item_id, role, direction, mention_date, created_at, source_account
      FROM entity_mentions WHERE entity_id = ?
    `).run(keepId, dupId);
    mentionsMoved += moveResult.changes;

    // Delete remaining mentions on dup (conflicts that were ignored)
    db.prepare('DELETE FROM entity_mentions WHERE entity_id = ?').run(dupId);

    // 2. Move aliases from dup → keep (skip conflicts)
    const existingAliases = db.prepare(
      'SELECT alias_normalized FROM entity_aliases WHERE entity_id = ?'
    ).all(keepId) as { alias_normalized: string }[];
    const existingSet = new Set(existingAliases.map(a => a.alias_normalized));

    const dupAliases = db.prepare(
      'SELECT alias, alias_normalized, source FROM entity_aliases WHERE entity_id = ?'
    ).all(dupId) as { alias: string; alias_normalized: string; source: string }[];

    for (const a of dupAliases) {
      if (!existingSet.has(a.alias_normalized)) {
        db.prepare(
          'INSERT INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)'
        ).run(randomUUID(), keepId, a.alias, a.alias_normalized, a.source);
        aliasesMoved++;
        existingSet.add(a.alias_normalized);
      }
    }

    // Also add the dup's canonical_name as an alias on the kept entity
    const dupNameNormalized = dupEntity.canonical_name.toLowerCase().trim();
    if (!existingSet.has(dupNameNormalized)) {
      db.prepare(
        'INSERT INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)'
      ).run(randomUUID(), keepId, dupEntity.canonical_name, dupNameNormalized, 'dedup-merge');
      aliasesMoved++;
    }

    // 3. If dup has an email and keep doesn't, copy it (check for uniqueness first)
    if (dupEntity.email && !action.keep.email) {
      try {
        db.prepare('UPDATE entities SET email = ? WHERE id = ?').run(dupEntity.email, keepId);
        action.keep.email = dupEntity.email;
      } catch (e: any) {
        // Email already exists on another entity — skip
      }
    }
    // Clear dup's email before deletion to avoid unique constraint issues
    if (dupEntity.email) {
      db.prepare('UPDATE entities SET email = NULL WHERE id = ?').run(dupId);
    }

    // 4. Delete the duplicate entity (CASCADE will clean up remaining aliases)
    db.prepare('DELETE FROM entities WHERE id = ?').run(dupId);
  });

  for (const dup of action.remove) {
    mergeOne(dup);
  }

  // Rename kept entity to preferred canonical name if different
  if (preferredName !== action.keep.canonical_name) {
    // Add old name as alias first
    const oldNorm = action.keep.canonical_name.toLowerCase().trim();
    const existingAlias = db.prepare(
      'SELECT id FROM entity_aliases WHERE entity_id = ? AND alias_normalized = ?'
    ).get(keepId, oldNorm);
    if (!existingAlias) {
      db.prepare(
        'INSERT INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)'
      ).run(randomUUID(), keepId, action.keep.canonical_name, oldNorm, 'dedup-rename');
    }
    db.prepare('UPDATE entities SET canonical_name = ?, updated_at = datetime(?) WHERE id = ?')
      .run(preferredName, new Date().toISOString(), keepId);
  }

  return { merged: action.remove.length, mentionsMoved, aliasesMoved };
}

// ── Remove the Luke Porter / Luke Billiot merge — they're different people ──
// Already removed from the groups above. But let's double-check by removing it.
const personGroupsFiltered = PERSON_MERGE_GROUPS.filter(g => {
  // Remove the Luke Porter + Luke Billiot group — different people
  if (g.includes('Luke Porter') && g.includes('Luke Billiot')) return false;
  return true;
});

// ── Main ───────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

console.log(`\n${'='.repeat(60)}`);
console.log(`  Entity Deduplication ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
console.log(`${'='.repeat(60)}\n`);

// Count before
const beforeCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as any).cnt;
console.log(`Entities before: ${beforeCount}\n`);

let totalMerged = 0;
let totalMentionsMoved = 0;
let totalAliasesMoved = 0;

// Process person merges
function runMerges(label: string, actions: MergeAction[]) {
  console.log(`── ${label} ──────────────────────────────────────`);
  for (const action of actions) {
    const a = action as MergeAction & { preferredName?: string };
    const keepMentions = getMentionCount(a.keep.id);
    const preferredName = a.preferredName || a.keep.canonical_name;
    const renamed = preferredName !== a.keep.canonical_name ? ` → rename to "${preferredName}"` : '';

    console.log(`\n  KEEP: "${a.keep.canonical_name}" (${keepMentions} mentions)${renamed}`);
    for (const dup of a.remove) {
      console.log(`  REMOVE: "${dup.canonical_name}" (${getMentionCount(dup.id)} mentions)`);
    }

    const result = executeMerge(a, DRY_RUN);
    totalMerged += result.merged;
    totalMentionsMoved += result.mentionsMoved;
    totalAliasesMoved += result.aliasesMoved;
    console.log(`  → Merged ${result.merged} duplicates, moved ${result.mentionsMoved} mentions, ${result.aliasesMoved} aliases`);
  }
}

const personActions = buildMergeActions(personGroupsFiltered, 'person');
runMerges('Person Merges', personActions);

console.log('\n');
const orgActions = buildMergeActions(ORG_MERGE_GROUPS, 'organization');
runMerges('Organization Merges', orgActions);

// Count after
const afterCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as any).cnt;

console.log(`\n${'='.repeat(60)}`);
console.log(`  Summary`);
console.log(`${'='.repeat(60)}`);
console.log(`  Entities before:    ${beforeCount}`);
console.log(`  Entities after:     ${afterCount}`);
console.log(`  Duplicates merged:  ${totalMerged}`);
console.log(`  Mentions moved:     ${totalMentionsMoved}`);
console.log(`  Aliases moved:      ${totalAliasesMoved}`);
console.log(`${'='.repeat(60)}\n`);

db.close();
