import type {
  Drill,
  DrillFloorRecord,
  DrillNode,
  DrillIssue,
  Floor,
  IssueTarget,
  NodePass,
} from '../model';
import { floorLabel } from '../store/id';

// ---------- 时间 ----------

/** "HH:mm" / "HH:mm:ss" / ISO 日期时间 → 当日零点起的秒数；非法返回 null */
export function parseTimeToSec(s?: string): number | null {
  if (!s) return null;
  const t = s.includes('T') ? s.slice(s.indexOf('T') + 1) : s;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] != null ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

/** 秒 → "m分s秒"（不足 1 分显示秒）；null 安全 */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || sec < 0 || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}分${rest}秒` : `${m}分`;
}

/** 楼层实际用时 = 结束 − 开始；缺任一返回 null，倒序视为无效 */
export function floorDurationSec(rec: DrillFloorRecord): number | null {
  const a = parseTimeToSec(rec.start);
  const b = parseTimeToSec(rec.end);
  if (a == null || b == null || b < a) return null;
  return b - a;
}

/** 全程用时 = 最晚的楼层结束时间 − 警报时间 */
export function drillTotalSec(d: Drill): number | null {
  const start = parseTimeToSec(d.alarmAt);
  if (start == null) return null;
  let last: number | null = null;
  for (const r of d.floors) {
    const e = parseTimeToSec(r.end);
    if (e != null && e >= start && (last == null || e > last)) last = e;
  }
  return last == null ? null : last - start;
}

/** 实际记录到的楼层结束数 / 楼层数，衡量本次演练数据完整度 */
export function drillCompleteness(d: Drill): { done: number; total: number } {
  const done = d.floors.filter((r) => parseTimeToSec(r.end) != null).length;
  return { done, total: d.floors.length };
}

// ---------- 关键节点分段 ----------

export type Segment = {
  index: number; // 0 = 警报 → 首节点
  from: string;
  to: string;
  toKind?: DrillNode['kind'];
  nodeId?: string;
  sec: number | null;
};

/**
 * 各段用时：警报 → 节点1、节点1 → 节点2……按 nodes 路线顺序。
 * 缺通过时间或时间倒序时该段为 null（不参与最慢评比）。
 */
export function drillSegments(d: Drill): Segment[] {
  const out: Segment[] = [];
  let prev = parseTimeToSec(d.alarmAt);
  let prevLabel = '警报';
  d.nodes.forEach((n, i) => {
    const at = parseTimeToSec(d.passes.find((p) => p.nodeId === n.id)?.at);
    out.push({
      index: i,
      from: prevLabel,
      to: n.name,
      toKind: n.kind,
      nodeId: n.id,
      sec: prev != null && at != null && at >= prev ? at - prev : null,
    });
    if (at != null) {
      prev = at;
      prevLabel = n.name;
    }
  });
  return out;
}

/** 全程最慢的一段（用时最大且有效的分段）；无有效段返回 null */
export function slowestSegment(d: Drill): Segment | null {
  let best: Segment | null = null;
  for (const seg of drillSegments(d)) {
    if (seg.sec != null && (best == null || seg.sec > best.sec!)) best = seg;
  }
  return best;
}

/** 排在最后撤离的楼层：结束时间最晚者（并列取高楼层） */
export function lastFloor(
  d: Drill,
  floorLevel: (floorId: string) => number | undefined,
): { floorId: string; end: string } | null {
  let best: { floorId: string; end: string; sec: number; level: number } | null = null;
  for (const r of d.floors) {
    const sec = parseTimeToSec(r.end);
    if (sec == null) continue;
    const level = floorLevel(r.floorId) ?? -Infinity;
    if (!best || sec > best.sec || (sec === best.sec && level > best.level)) {
      best = { floorId: r.floorId, end: r.end!, sec, level };
    }
  }
  return best ? { floorId: best.floorId, end: best.end } : null;
}

// ---------- 多次演练对比 ----------

export type TrendPoint = {
  drillId: string;
  date: string;
  sec: number | null;
  blocked: boolean;
};

/** 同一楼层历次用时（按日期升序），含本次是否堵口 */
export function floorTrend(drills: Drill[], floorId: string): TrendPoint[] {
  return drills
    .map((d) => {
      const rec = d.floors.find((r) => r.floorId === floorId);
      return {
        drillId: d.id,
        date: d.date,
        sec: rec ? floorDurationSec(rec) : null,
        blocked: !!rec?.blocked,
      };
    })
    .filter((p) => p.sec != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 出口使用统计：有关联设施按 facilityId 归并，否则按「楼层+节点名」归并 */
export type ExitUsage = {
  key: string;
  name: string;
  facilityId?: string;
  count: number;
  drills: string[]; // 使用过该出口的演练
};

export function exitUsage(drills: Drill[]): ExitUsage[] {
  const map = new Map<string, ExitUsage>();
  for (const d of drills) {
    for (const n of d.nodes) {
      if (n.kind !== 'exit') continue;
      const used = parseTimeToSec(d.passes.find((p) => p.nodeId === n.id)?.at) != null;
      if (!used) continue;
      const key = n.facilityId ?? `name:${n.floorId ?? ''}:${n.name}`;
      const e = map.get(key);
      if (e) {
        e.count++;
        if (!e.drills.includes(d.id)) e.drills.push(d.id);
      } else {
        map.set(key, { key, name: n.name, facilityId: n.facilityId, count: 1, drills: [d.id] });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 「老是排最后」的楼层排名：各演练最晚结束楼层的出现次数 */
export function lastFloorRanking(
  drills: Drill[],
  floorLevel: (floorId: string) => number | undefined,
): { floorId: string; count: number; lastDate: string }[] {
  const map = new Map<string, { count: number; lastDate: string }>();
  for (const d of drills) {
    const lf = lastFloor(d, floorLevel);
    if (!lf) continue;
    const cur = map.get(lf.floorId) ?? { count: 0, lastDate: '' };
    cur.count++;
    if (d.date > cur.lastDate) cur.lastDate = d.date;
    map.set(lf.floorId, cur);
  }
  return [...map.entries()]
    .map(([floorId, v]) => ({ floorId, ...v }))
    .sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate));
}

/** 楼层堵口率：堵口次数 / 有记录的演练次数 */
export function blockedRate(drills: Drill[], floorId: string): { blocked: number; total: number } {
  let blocked = 0;
  let total = 0;
  for (const d of drills) {
    const rec = d.floors.find((r) => r.floorId === floorId);
    if (rec && parseTimeToSec(rec.end) != null) {
      total++;
      if (rec.blocked) blocked++;
    }
  }
  return { blocked, total };
}

// ---------- 问题挂接 ----------

export function resolveTargetLabel(target: IssueTarget, floors: Record<string, Floor>): string {
  if (target.kind === 'other') return target.label || '未指定位置';
  const f = floors[target.floorId];
  const fl = f ? floorLabel(f.level) : '?F';
  if (target.kind === 'room') {
    const room = f?.rooms.find((r) => r.id === target.roomId);
    return `${fl} ${room?.name ?? '已删除房间'}`;
  }
  const fac = f?.facilities.find((x) => x.id === target.facilityId);
  return fac ? `${fl} ${fac.code}` : `${fl} 设施（已删除）`;
}

export function issueOpen(i: DrillIssue): boolean {
  return i.status === 'open';
}

/** 该问题在指定演练中的复查结论（若有） */
export function followUpAt(i: DrillIssue, drillId: string) {
  return i.followUps.find((f) => f.drillId === drillId);
}
