import type Database from 'better-sqlite3';

// ============================================================
// Revenue Pipeline Model — Phase B1
// Quantitative strategic analysis from entity graph + commitments
// ============================================================

export interface DealStage {
  project: string;
  item_count: number;
  last_activity: string;
  days_since: number;
  stale: boolean;
  people_count: number;
  key_people: string[];
  commitments_active: number;
  commitments_overdue: number;
  activity_trend: 'accelerating' | 'steady' | 'decelerating' | 'stalled';
}

export interface PipelineAnalysis {
  generated_at: string;
  deals: DealStage[];
  time_allocation: { project: string; hours_proxy: number; pct: number }[];
  recommendations: string[];
  bottlenecks: string[];
}

export function analyzePipeline(db: Database.Database): PipelineAnalysis {
  const now = new Date();

  // Get active projects with metrics
  const projects = db.prepare(`
    SELECT project, COUNT(*) as items,
      MAX(source_date) as last_activity,
      COUNT(CASE WHEN source_date >= datetime('now', '-7 days') THEN 1 END) as recent_7d,
      COUNT(CASE WHEN source_date >= datetime('now', '-14 days') AND source_date < datetime('now', '-7 days') THEN 1 END) as prev_7d,
      GROUP_CONCAT(DISTINCT source) as sources
    FROM knowledge
    WHERE project IS NOT NULL AND project != ''
    GROUP BY project
    HAVING items >= 3
    ORDER BY MAX(source_date) DESC
  `).all() as any[];

  const deals: DealStage[] = projects.map(p => {
    const daysSince = p.last_activity
      ? Math.floor((now.getTime() - new Date(p.last_activity).getTime()) / 86400000)
      : 999;

    // Get people involved
    const people = db.prepare(`
      SELECT e.canonical_name, COUNT(*) as cnt
      FROM entity_mentions em
      JOIN knowledge k ON em.knowledge_item_id = k.id
      JOIN entities e ON em.entity_id = e.id
      WHERE k.project = ? AND e.type = 'person' AND e.user_dismissed = 0
        AND e.canonical_name != 'Zach Stock'
      GROUP BY e.canonical_name
      ORDER BY cnt DESC LIMIT 5
    `).all(p.project) as any[];

    // Get commitments
    const commitments = db.prepare(`
      SELECT state, COUNT(*) as cnt FROM commitments
      WHERE project = ? GROUP BY state
    `).all(p.project) as any[];

    const active = commitments.find((c: any) => c.state === 'active')?.cnt || 0;
    const overdue = commitments.find((c: any) => c.state === 'overdue')?.cnt || 0;

    // Activity trend
    let trend: DealStage['activity_trend'];
    if (p.recent_7d > p.prev_7d * 1.5) trend = 'accelerating';
    else if (p.recent_7d > 0 && p.recent_7d >= p.prev_7d * 0.5) trend = 'steady';
    else if (p.recent_7d > 0) trend = 'decelerating';
    else trend = 'stalled';

    return {
      project: p.project,
      item_count: p.items,
      last_activity: p.last_activity,
      days_since: daysSince,
      stale: daysSince > 14,
      people_count: people.length,
      key_people: people.map((pp: any) => pp.canonical_name),
      commitments_active: active,
      commitments_overdue: overdue,
      activity_trend: trend,
    };
  });

  // Time allocation (proxy: count of items per project in last 14 days)
  const recentActivity = db.prepare(`
    SELECT project, COUNT(*) as items
    FROM knowledge
    WHERE project IS NOT NULL AND source_date >= datetime('now', '-14 days')
    GROUP BY project
    ORDER BY items DESC
  `).all() as any[];

  const totalRecent = recentActivity.reduce((s: number, r: any) => s + r.items, 0) || 1;
  const timeAllocation = recentActivity.map((r: any) => ({
    project: r.project,
    hours_proxy: r.items,
    pct: Math.round((r.items / totalRecent) * 100),
  }));

  // Generate recommendations
  const recommendations: string[] = [];
  const bottlenecks: string[] = [];

  // Find stalled high-value deals
  for (const deal of deals) {
    if (deal.activity_trend === 'stalled' && deal.item_count >= 10) {
      bottlenecks.push(`${deal.project}: stalled (${deal.days_since}d no activity, ${deal.item_count} total items)`);
    }
    if (deal.commitments_overdue > 0) {
      bottlenecks.push(`${deal.project}: ${deal.commitments_overdue} overdue commitments`);
    }
  }

  // Time allocation mismatches
  const topByItems = deals.sort((a, b) => b.item_count - a.item_count)[0];
  const topByRecent = timeAllocation[0];
  if (topByItems && topByRecent && topByItems.project !== topByRecent.project) {
    recommendations.push(
      `Largest project (${topByItems.project}, ${topByItems.item_count} items) is not where you're spending the most time (${topByRecent.project}, ${topByRecent.pct}% of recent activity)`
    );
  }

  // Accelerating deals deserve more attention
  for (const deal of deals) {
    if (deal.activity_trend === 'accelerating') {
      recommendations.push(`${deal.project} is accelerating — lean in. ${deal.people_count} people active.`);
    }
  }

  // Decelerating deals need intervention
  for (const deal of deals) {
    if (deal.activity_trend === 'decelerating' && deal.item_count >= 5) {
      recommendations.push(`${deal.project} is decelerating — needs attention or explicit deprioritization.`);
    }
  }

  return {
    generated_at: now.toISOString(),
    deals: deals.sort((a, b) => b.item_count - a.item_count),
    time_allocation: timeAllocation,
    recommendations,
    bottlenecks,
  };
}
