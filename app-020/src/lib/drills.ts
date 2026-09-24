/**
 * 疏散演练统计引擎（纯函数）：
 * - 楼层段用时 = 相邻关键节点通过时刻之差（开始→首节点、末节点→结束也计入）
 * - 全程最慢段：一次演练各层所有段中用时最长的一段
 * - 多次演练对比：同楼层用时趋势、出口使用频次、垫底楼层、拥堵
 * - 问题复查：按房间/设施挂接，跨演练追踪改进状态
 *
 * 时间一律用 'YYYY-MM-DDTHH:mm[:ss]' 本地挂钟字符串（同一天演练，可仅精确到分）。
 */
import type {
  Drill,
  DrillFloorRecord,
  DrillIssue,
  DrillNode,
  Floor,
} from '../model';

// ---------- 时间 ----------

/** 挂钟时间字符串 → 当日毫秒数；解析失败返回 null */
export function parseClockMs(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = m[4] != null ? Number(m[4]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return ((hh * 60 + mm) * 60 + ss) * 1000;
}

/** 秒数 → mm:ss（超过 1 小时用 h:mm:ss）；null → '—' */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p2 = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

/** 'YYYY-MM-DDTHH:mm' 展示用 → 'HH:mm[:ss]' */
export function fmtClock(s: string | undefined | null): string {
  const ms = parseClockMs(s);
  if (ms == null) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const p2 = (v: number) => String(v).padStart(2, '0');
  const hasSec = /T\d{1,2}:\d{2}:\d{2}$/.test((s ?? '').trim());
  return `${p2(h)}:${p2(m)}${hasSec ? `:${p2(sec)}` : ''}`;
}

// ---------- 段用时 ----------

export type DrillSegment = {
  /** 段类型：start=开始→首节点，node=节点间，end=末节点→结束，floor=仅有开始/结束的整层 */
  kind: 'start' | 'node' | 'end' | 'floor';
  fromLabel: string;
  toLabel: string;
  /** 起点节点 id（node/end 段）；start 段与 floor 段无 */
  fromNodeId?: string;
  /** 终点节点 id（start/node 段）；end 段终点是「结束」，故 id 放在 fromNodeId */
  toNodeId?: string;
  durationMs: number;
  /** 该段是否为两层共用的楼梯段（终点节点是本层首个楼梯口，上一层以同名楼梯口收尾） */
  crossFloor?: boolean;
  /** 时间倒挂（后一时刻早于前一时刻），录入有误 */
  anomalous?: boolean;
};

export type FloorTiming = {
  totalMs: number | null; // 本层开始→结束
  segments: DrillSegment[];
  /** 本层最慢段（不含跨层楼梯段，跨层段在全程视角里只算一次） */
  slowest: DrillSegment | null;
  /** 时间倒挂/无法解析的点数（缺记不算异常） */
  anomalies: number;
  missing: boolean; // 开始或结束缺失
};

/**
 * 一层的段用时：开始→节点1→…→节点n→结束，相邻时刻作差。
 * 缺记时刻的相邻段跳过（不计入也不报错）；倒挂（负值）保留并标 anomalous。
 */
export function floorTiming(rec: DrillFloorRecord): FloorTiming {
  const t0 = parseClockMs(rec.startedAt);
  const t1 = parseClockMs(rec.completedAt);
  const segments: DrillSegment[] = [];
  let anomalies = 0;

  const push = (kind: DrillSegment['kind'], from: string, to: string, a: number | null, b: number | null, fromNodeId?: string, toNodeId?: string) => {
    if (a == null || b == null) return; // 缺记：跳过该段
    const d = b - a;
    if (d < 0) anomalies++;
    segments.push({ kind, fromLabel: from, toLabel: to, durationMs: d, anomalous: d < 0, fromNodeId, toNodeId });
  };

  const nodes = rec.nodes ?? [];
  if (nodes.length === 0) {
    push('floor', '开始', '结束', t0, t1);
  } else {
    push('start', '开始', nodes[0].label || '节点1', t0, parseClockMs(nodes[0].time), undefined, nodes[0].id);
    for (let i = 1; i < nodes.length; i++) {
      push(
        'node',
        nodes[i - 1].label || `节点${i}`,
        nodes[i].label || `节点${i + 1}`,
        parseClockMs(nodes[i - 1].time),
        parseClockMs(nodes[i].time),
        nodes[i - 1].id,
        nodes[i].id,
      );
    }
    push(
      'end',
      nodes[nodes.length - 1].label || `节点${nodes.length}`,
      '结束',
      parseClockMs(nodes[nodes.length - 1].time),
      t1,
      nodes[nodes.length - 1].id,
      undefined,
    );
  }

  // 本层最慢段：排除跨层段（先按非跨层算，跨层标记由 drillFloorTimings 补）
  const candidates = segments.filter((g) => !g.anomalous);
  const slowest = candidates.length ? candidates.reduce((a, b) => (b.durationMs > a.durationMs ? b : a)) : null;
  // 开始晚于结束本身就是倒挂（无有效节点段时也要能发现）
  const total = t0 != null && t1 != null ? t1 - t0 : null;
  if (total != null && total < 0) anomalies++;

  return { totalMs: total != null && total >= 0 ? total : null, segments, slowest, anomalies, missing: t0 == null || t1 == null };
}

export type SlowestSegment = {
  floorId: string;
  segment: DrillSegment;
};

/**
 * 全程视角下各层 timing：相邻两层若以同名楼梯口衔接（上层末节点、本层首节点），
 * 上层的「末节点→结束」段标记为跨层楼梯段（人从上层经楼梯进入下层的那段时间）。
 */
export function drillFloorTimings(drill: Drill): Map<string, FloorTiming> {
  const recs = drill.floors ?? [];
  const timings = recs.map((r) => floorTiming(r));
  for (let fi = 1; fi < recs.length; fi++) {
    const firstNode = recs[fi].nodes?.[0];
    const prevLast = recs[fi - 1].nodes?.[recs[fi - 1].nodes.length - 1];
    if (
      firstNode &&
      prevLast &&
      firstNode.kind === 'stair' &&
      prevLast.kind === 'stair' &&
      (firstNode.label || '').trim() === (prevLast.label || '').trim()
    ) {
      // 上一层「末节点→结束」段即跨层楼梯衔接段，打标记用于展示
      for (const seg of timings[fi - 1].segments) {
        if (seg.kind === 'end' && seg.fromNodeId === prevLast.id) seg.crossFloor = true;
      }
    }
  }
  const map = new Map<string, FloorTiming>();
  recs.forEach((r, i) => map.set(r.floorId, timings[i]));
  return map;
}

/** 全程最慢段：各层所有段中用时最长者 */
export function drillSlowestSegment(drill: Drill): SlowestSegment | null {
  let worst: SlowestSegment | null = null;
  for (const [floorId, timing] of drillFloorTimings(drill)) {
    for (const seg of timing.segments) {
      if (seg.anomalous) continue;
      if (!worst || seg.durationMs > worst.segment.durationMs) worst = { floorId, segment: seg };
    }
  }
  return worst;
}

// ---------- 楼层完成名次 ----------

/** 各层结束时刻排序：最后完成（垫底）的楼层 id；结束时刻缺失的层不参与 */
export function lastFinishedFloor(drill: Drill): string | null {
  let lastId: string | null = null;
  let lastT = -1;
  for (const rec of drill.floors ?? []) {
    const t = parseClockMs(rec.completedAt);
    if (t == null) continue;
    if (t > lastT) {
      lastT = t;
      lastId = rec.floorId;
    }
  }
  return lastId;
}

/** 结束时刻升序的楼层 id 列表 */
export function floorFinishOrder(drill: Drill): string[] {
  return (drill.floors ?? [])
    .map((rec) => ({ floorId: rec.floorId, t: parseClockMs(rec.completedAt) }))
    .filter((x): x is { floorId: string; t: number } => x.t != null)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.floorId);
}

// ---------- 多次演练对比 ----------

export type FloorTrendPoint = {
  drillId: string;
  date: string;
  durationMs: number | null;
  blocked: boolean;
  rank: number | null; // 该层在本次演练中的完成名次（1 = 最先），null 为缺数据
};

/** 同一楼层历次演练的用时变化（按日期升序） */
export function floorDurationTrend(drills: Drill[], floorId: string): FloorTrendPoint[] {
  return drills
    .filter((d) => (d.floors ?? []).some((r) => r.floorId === floorId))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const rec = d.floors.find((r) => r.floorId === floorId)!;
      const order = floorFinishOrder(d);
      return {
        drillId: d.id,
        date: d.date,
        durationMs: floorTiming(rec).totalMs,
        blocked: !!rec.blocked,
        rank: order.includes(floorId) ? order.indexOf(floorId) + 1 : null,
      };
    });
}

export type ExitUsage = {
  /** 出口键：exitFacilityId 优先；自由命名节点用 label */
  key: string;
  label: string;
  facilityId?: string;
  floorId?: string;
  count: number;
  drillIds: string[];
};

/**
 * 出口使用频次：统计所有演练各层节点中 kind==='exit' 且记录了通过时间的出口。
 * 同一次演练里同一出口在多层出现（楼梯下来共用一个出口）只计 1 次。
 */
export function exitUsageStats(drills: Drill[]): ExitUsage[] {
  const map = new Map<string, ExitUsage>();
  for (const d of drills) {
    const seen = new Set<string>();
    for (const rec of d.floors ?? []) {
      for (const n of rec.nodes ?? []) {
        if (n.kind !== 'exit' || !n.time) continue;
        const key = n.exitFacilityId || `label:${(n.label || '出口').trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cur = map.get(key);
        if (cur) {
          cur.count++;
          cur.drillIds.push(d.id);
        } else {
          map.set(key, {
            key,
            label: n.label || '出口',
            facilityId: n.exitFacilityId,
            floorId: rec.floorId,
            count: 1,
            drillIds: [d.id],
          });
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type FloorLastCount = {
  floorId: string;
  count: number;
  total: number; // 该层参加且有结束时间的演练次数
};

/** 各楼层「老排最后」的次数（按垫底次数降序；只统计参加 ≥1 次的层） */
export function lastPlaceCounts(drills: Drill[]): FloorLastCount[] {
  const counts = new Map<string, { last: number; total: number }>();
  for (const d of drills) {
    const order = floorFinishOrder(d); // 只有结束时间完整的层参与
    for (const fid of order) {
      const c = counts.get(fid) ?? { last: 0, total: 0 };
      c.total++;
      counts.set(fid, c);
    }
    const last = order[order.length - 1];
    // 单层演练不算「垫底」——没有对比对象
    if (last && order.length > 1) counts.get(last)!.last++;
  }
  return [...counts.entries()]
    .map(([floorId, c]) => ({ floorId, count: c.last, total: c.total }))
    .sort((a, b) => b.count - a.count || b.total - a.total);
}

/** 各楼层在历次演练中堵在楼道口的次数与堵点描述 */
export function blockageCounts(drills: Drill[]): { floorId: string; count: number; notes: string[] }[] {
  const map = new Map<string, { count: number; notes: string[] }>();
  for (const d of drills) {
    for (const rec of d.floors ?? []) {
      if (!rec.blocked) continue;
      const c = map.get(rec.floorId) ?? { count: 0, notes: [] };
      c.count++;
      if (rec.blockedNote) c.notes.push(`${d.date} ${rec.blockedNote}`);
      map.set(rec.floorId, c);
    }
  }
  return [...map.entries()].map(([floorId, c]) => ({ floorId, ...c })).sort((a, b) => b.count - a.count);
}

// ---------- 录入校验 ----------

export type DrillWarning = {
  level: 'error' | 'warning';
  message: string;
};

/** 录入自检：必填缺失为 error；时刻倒挂/节点缺记为 warning */
export function drillWarnings(drill: Drill): DrillWarning[] {
  const out: DrillWarning[] = [];
  if (!drill.date) out.push({ level: 'error', message: '未填演练日期' });
  if (drill.participants == null) out.push({ level: 'warning', message: '未填参演总人数' });
  if (!drill.fireOrigin.floorId && !(drill.fireOrigin.detail ?? '').trim()) {
    out.push({ level: 'warning', message: '未记录假设起火点' });
  }
  if (!(drill.floors ?? []).length) out.push({ level: 'warning', message: '还没有任何楼层记录' });
  for (const rec of drill.floors ?? []) {
    if (!rec.commander.trim()) out.push({ level: 'error', message: `楼层 ${rec.floorId} 未填疏散指挥` });
    const timing = floorTiming(rec);
    if (timing.missing) out.push({ level: 'warning', message: `楼层 ${rec.floorId} 开始/结束时间不完整` });
    if (timing.anomalies > 0) out.push({ level: 'error', message: `楼层 ${rec.floorId} 有 ${timing.anomalies} 处时间倒挂（后一时刻早于前一时刻）` });
    const missingNodes = rec.nodes.filter((n) => !n.time);
    if (missingNodes.length) out.push({ level: 'warning', message: `楼层 ${rec.floorId} 有 ${missingNodes.length} 个节点未记通过时间` });
  }
  return out;
}

// ---------- 问题（挂房间/设施，跨演练复查） ----------

export type IssueTarget =
  | { kind: 'room'; floorId: string; roomId: string }
  | { kind: 'facility'; floorId: string; facilityId: string }
  | { kind: 'floor'; floorId: string }
  | { kind: 'none' };

export function issueTarget(issue: DrillIssue): IssueTarget {
  if (issue.facilityId && issue.floorId) return { kind: 'facility', floorId: issue.floorId, facilityId: issue.facilityId };
  if (issue.roomId && issue.floorId) return { kind: 'room', floorId: issue.floorId, roomId: issue.roomId };
  if (issue.floorId) return { kind: 'floor', floorId: issue.floorId };
  return { kind: 'none' };
}

/** 截至某次演练结束时仍待改进的问题（此时点之后才复查解决的仍算挂账） */
export function openIssuesAt(drills: Drill[], drillId: string): DrillIssue[] {
  const drill = drills.find((d) => d.id === drillId);
  if (!drill) return [];
  const at = new Date(`${drill.date}T23:59:59`).getTime();
  const out: DrillIssue[] = [];
  for (const d of drills) {
    if (d.date > drill.date) continue;
    for (const i of d.issues ?? []) {
      // 在此时点已复查解决/关闭的不再算挂账；状态虽改但解决日期晚于该时点的仍计入
      if (i.status !== 'open' && i.resolvedAt && parseDateMs(i.resolvedAt) <= at) continue;
      out.push(i);
    }
  }
  return out;
}

function parseDateMs(s: string): number {
  return new Date(`${s}T00:00:00`).getTime();
}

/**
 * 录入某次演练时要复查的问题 = 此前历次演练挂账、到本次开始时仍 open 的问题。
 * 按挂接目标分组返回，方便在录入页逐项勾「已改进/仍存在」。
 */
export function followUpsForDrill(drills: Drill[], drill: Drill): DrillIssue[] {
  const at = parseDateMs(drill.date);
  const out: DrillIssue[] = [];
  for (const d of drills) {
    if (d.id === drill.id || d.date > drill.date) continue;
    for (const i of d.issues ?? []) {
      if (i.status !== 'open') continue;
      if (i.resolvedAt && parseDateMs(i.resolvedAt) <= at) continue;
      out.push(i);
    }
  }
  return out;
}

/** 挂在某楼层（含其房间/设施）上的未解决问题（楼层编辑器里提示用） */
export function openIssuesOnFloor(drills: Drill[], floorId: string): DrillIssue[] {
  const out: DrillIssue[] = [];
  for (const d of drills) {
    for (const i of d.issues ?? []) {
      if (i.status === 'open' && i.floorId === floorId) out.push(i);
    }
  }
  return out;
}

/** 节点的展示名：出口设施优先用设施 code（楼层里的真实出口） */
export function nodeDisplayName(node: DrillNode, floors: Record<string, Floor>): string {
  if (node.exitFacilityId) {
    for (const f of Object.values(floors)) {
      const fac = f.facilities.find((x) => x.id === node.exitFacilityId);
      if (fac) return fac.code;
    }
  }
  return node.label || (node.kind === 'exit' ? '出口' : '楼梯口');
}
