/**
 * 疏散演练统计验收用例：
 * - 楼层实际用时 / 全程用时 / 关键节点分段 / 最慢段
 * - 多次演练对比：同层历次用时、出口使用次数、老是排最后的楼层
 * - 问题挂接到房间/设施并跨演练复查
 */
import { describe, it, expect } from 'vitest';
import type { Drill, DrillNode, DrillIssue, Floor } from '../src/model';
import {
  blockedRate,
  drillCompleteness,
  drillSegments,
  drillTotalSec,
  exitUsage,
  floorDurationSec,
  floorTrend,
  fmtDur,
  lastFloor,
  lastFloorRanking,
  parseTimeToSec,
  resolveTargetLabel,
  slowestSegment,
} from '../src/lib/drills';

function mkDrill(partial: Partial<Drill> & Pick<Drill, 'id' | 'date' | 'buildingId'>): Drill {
  return {
    alarmAt: '09:00',
    participants: 0,
    nodes: [],
    floors: [],
    passes: [],
    createdAt: '',
    ...partial,
  };
}

const node = (id: string, kind: DrillNode['kind'], name: string, extra: Partial<DrillNode> = {}): DrillNode => ({
  id, kind, name, ...extra,
});

describe('时间解析与格式化', () => {
  it('L1 支持 HH:mm 与 HH:mm:ss，非法/缺省为 null', () => {
    expect(parseTimeToSec('09:00')).toBe(9 * 3600);
    expect(parseTimeToSec('09:00:30')).toBe(9 * 3600 + 30);
    expect(parseTimeToSec('2026-09-24T10:05:00')).toBe(10 * 3600 + 5 * 60);
    expect(parseTimeToSec('')).toBeNull();
    expect(parseTimeToSec(undefined)).toBeNull();
    expect(parseTimeToSec('25:00')).toBeNull();
    expect(parseTimeToSec('09:61')).toBeNull();
  });

  it('L2 时长格式化', () => {
    expect(fmtDur(0)).toBe('0秒');
    expect(fmtDur(45)).toBe('45秒');
    expect(fmtDur(120)).toBe('2分');
    expect(fmtDur(140)).toBe('2分20秒');
    expect(fmtDur(null)).toBe('—');
  });
});

describe('楼层与全程用时', () => {
  it('L3 楼层实际用时 = 结束 − 开始；缺失或倒序为 null', () => {
    expect(floorDurationSec({ floorId: 'f', commander: '', start: '09:00', end: '09:03:20', blocked: false })).toBe(200);
    expect(floorDurationSec({ floorId: 'f', commander: '', start: '09:03:20', end: '09:03:00', blocked: false })).toBeNull();
    expect(floorDurationSec({ floorId: 'f', commander: '', blocked: false })).toBeNull();
  });

  it('L4 全程用时 = 最晚楼层结束 − 警报时间，与录入顺序无关', () => {
    const d = mkDrill({
      id: 'd1', date: '2026-09-01', buildingId: 'b', alarmAt: '09:00',
      floors: [
        { floorId: 'f1', commander: '', start: '09:00', end: '09:02:40', blocked: false },
        { floorId: 'f2', commander: '', start: '09:00', end: '09:04:10', blocked: true },
        { floorId: 'f3', commander: '', start: '09:00', end: '09:03:05', blocked: false },
      ],
    });
    expect(drillTotalSec(d)).toBe(250); // 4分10秒
    expect(drillCompleteness(d)).toEqual({ done: 3, total: 3 });
  });

  it('L5 早于警报的结束时间不计入全程', () => {
    const d = mkDrill({
      id: 'd1', date: '2026-09-01', buildingId: 'b', alarmAt: '10:00',
      floors: [{ floorId: 'f1', commander: '', start: '10:00', end: '09:59', blocked: false }],
    });
    expect(drillTotalSec(d)).toBeNull();
  });
});

describe('关键节点分段与最慢段', () => {
  const d = mkDrill({
    id: 'd1', date: '2026-09-01', buildingId: 'b', alarmAt: '09:00',
    nodes: [
      node('n1', 'stair', '3F 东楼梯口'),
      node('n2', 'stair', '2F 东楼梯口'),
      node('n3', 'exit', '西出口', { facilityId: 'ex1' }),
    ],
    passes: [
      { nodeId: 'n1', at: '09:01:30' },
      { nodeId: 'n2', at: '09:02:20' },
      { nodeId: 'n3', at: '09:03:55' },
    ],
  });

  it('L6 各段用时按路线顺序相邻相减，首段以警报为起点', () => {
    const segs = drillSegments(d);
    expect(segs.map((s) => s.sec)).toEqual([90, 50, 95]);
    expect(segs[0].from).toBe('警报');
    expect(segs[0].to).toBe('3F 东楼梯口');
    expect(segs[2].toKind).toBe('exit');
  });

  it('L7 找出全程最慢的一段', () => {
    const slow = slowestSegment(d)!;
    expect(slow.nodeId).toBe('n3');
    expect(slow.sec).toBe(95);
    expect(slow.to).toBe('西出口');
  });

  it('L8 中间节点漏记通过时间：该段为 null 且不中断后续计算（断点前时间保留）', () => {
    const d2 = mkDrill({
      id: 'd2', date: '2026-09-02', buildingId: 'b', alarmAt: '09:00',
      nodes: [node('n1', 'stair', 'A'), node('n2', 'stair', 'B'), node('n3', 'exit', 'C')],
      passes: [{ nodeId: 'n1', at: '09:01:00' }, { nodeId: 'n3', at: '09:02:00' }],
    });
    const segs = drillSegments(d2);
    expect(segs[0].sec).toBe(60);
    expect(segs[1].sec).toBeNull(); // B 缺时间
    expect(segs[2].sec).toBe(60);   // B→C 仍按前一有效时间点 A 计算
    expect(slowestSegment(d2)?.sec).toBe(60);
  });

  it('L9 时间倒序的段判无效', () => {
    const d2 = mkDrill({
      id: 'd2', date: '2026-09-02', buildingId: 'b', alarmAt: '09:05',
      nodes: [node('n1', 'exit', '出口')],
      passes: [{ nodeId: 'n1', at: '09:04' }],
    });
    expect(drillSegments(d2)[0].sec).toBeNull();
    expect(slowestSegment(d2)).toBeNull();
  });
});

describe('多次演练对比', () => {
  const drills: Drill[] = [
    mkDrill({
      id: 'd1', date: '2026-08-01', buildingId: 'b', alarmAt: '09:00',
      floors: [
        { floorId: 'f3', commander: '王', start: '09:00', end: '09:04:10', blocked: true },
        { floorId: 'f2', commander: '李', start: '09:00', end: '09:03:05', blocked: false },
        { floorId: 'f1', commander: '赵', start: '09:00', end: '09:02:40', blocked: false },
      ],
      nodes: [node('e1', 'exit', '西出口', { facilityId: 'ex1' })],
      passes: [{ nodeId: 'e1', at: '09:03:55' }],
    }),
    mkDrill({
      id: 'd2', date: '2026-09-01', buildingId: 'b', alarmAt: '10:00',
      floors: [
        { floorId: 'f3', commander: '王', start: '10:00', end: '10:03:20', blocked: false },
        { floorId: 'f2', commander: '李', start: '10:00', end: '10:03:30', blocked: true },
        { floorId: 'f1', commander: '赵', start: '10:00', end: '10:02:25', blocked: false },
      ],
      nodes: [
        node('ew', 'exit', '西出口', { facilityId: 'ex1' }),
        node('ee', 'exit', '东出口', { facilityId: 'ex2' }),
      ],
      passes: [{ nodeId: 'ew', at: '10:02:40' }, { nodeId: 'ee', at: '10:02:50' }],
    }),
  ];
  const levelOf = (fid: string) => ({ f1: 1, f2: 2, f3: 3 })[fid];

  it('L10 同一楼层历次用时按日期升序，可看出变化；缺记录的演练被过滤', () => {
    const t3 = floorTrend(drills, 'f3');
    expect(t3.map((p) => p.drillId)).toEqual(['d1', 'd2']);
    expect(t3[0].sec).toBe(250);
    expect(t3[1].sec).toBe(200); // 4分10秒 → 3分20秒，快了 50 秒
    expect(t3[0].blocked).toBe(true);
    expect(floorTrend(drills, 'fX')).toEqual([]);
  });

  it('L11 出口使用次数：同一 facilityId 跨演练归并，西出口 2 次 > 东出口 1 次', () => {
    const usage = exitUsage(drills);
    expect(usage.map((u) => [u.name, u.count])).toEqual([['西出口', 2], ['东出口', 1]]);
    expect(usage[0].facilityId).toBe('ex1');
    // 未记通过时间的出口不计入
    const d3 = mkDrill({
      id: 'd3', date: '2026-09-10', buildingId: 'b',
      nodes: [node('x', 'exit', '没人走的出口', { facilityId: 'ex3' })],
      passes: [],
    });
    expect(exitUsage([d3])).toEqual([]);
  });

  it('L12 哪层老是排最后：两次演练分别 f3/f2 垫底 → 排名按次数', () => {
    expect(lastFloor(drills[0], levelOf)?.floorId).toBe('f3');
    expect(lastFloor(drills[1], levelOf)?.floorId).toBe('f2');
    const rank = lastFloorRanking(drills, levelOf);
    expect(rank.map((r) => r.floorId)).toEqual(['f2', 'f3']); // 并列 1 次，最近日期优先
    expect(rank[0].lastDate).toBe('2026-09-01');
  });

  it('L13 并列最晚时取高楼层为最后', () => {
    const d = mkDrill({
      id: 'd', date: '2026-09-01', buildingId: 'b', alarmAt: '09:00',
      floors: [
        { floorId: 'f1', commander: '', start: '09:00', end: '09:03:00', blocked: false },
        { floorId: 'f2', commander: '', start: '09:00', end: '09:03:00', blocked: false },
      ],
    });
    expect(lastFloor(d, levelOf)?.floorId).toBe('f2');
  });

  it('L14 楼层堵口率：f3 = 1/2，f1 = 0/2', () => {
    expect(blockedRate(drills, 'f3')).toEqual({ blocked: 1, total: 2 });
    expect(blockedRate(drills, 'f1')).toEqual({ blocked: 0, total: 2 });
  });
});

describe('问题挂接到房间/设施', () => {
  const floors: Record<string, Floor> = {
    f3: {
      id: 'f3', buildingId: 'b', level: 3, scaleMmPerUnit: 1, version: 0,
      rooms: [{ id: 'r1', polygon: [], name: '302室', usage: 'office', areaM2: 40 }],
      facilities: [{ id: 'fc1', kind: 'exit', x: 0, y: 0, code: '3F-EXIT-01', checks: [] }],
      exits: [],
    },
  };

  it('L15 挂到房间 / 设施时解析出「楼层 + 名称」；目标删除后优雅降级', () => {
    expect(resolveTargetLabel({ kind: 'room', floorId: 'f3', roomId: 'r1' }, floors)).toBe('3F 302室');
    expect(resolveTargetLabel({ kind: 'facility', floorId: 'f3', facilityId: 'fc1' }, floors)).toBe('3F 3F-EXIT-01');
    expect(resolveTargetLabel({ kind: 'room', floorId: 'f3', roomId: 'gone' }, floors)).toContain('已删除房间');
    expect(resolveTargetLabel({ kind: 'other', label: '东楼梯口转角' }, floors)).toBe('东楼梯口转角');
  });

  it('L16 问题有复查轨迹：复查为 fixed → 状态关闭；回潮为 still/worse → 重新打开', () => {
    const issue: DrillIssue = {
      id: 'i1', buildingId: 'b', drillId: 'd1',
      target: { kind: 'room', floorId: 'f3', roomId: 'r1' },
      description: '楼道堆物', status: 'open', createdAt: '', followUps: [],
    };
    // 模拟 store.addFollowUp 的状态机
    const apply = (result: 'fixed' | 'still' | 'worse', drillId: string) => {
      issue.followUps = issue.followUps.filter((f) => f.drillId !== drillId);
      issue.followUps.push({ drillId, result, at: '' });
      if (result === 'fixed') issue.status = 'fixed';
      else if (issue.status === 'fixed') issue.status = 'open';
    };
    apply('fixed', 'd2');
    expect(issue.status).toBe('fixed');
    apply('still', 'd3');
    expect(issue.status).toBe('open');
    expect(issue.followUps).toHaveLength(2);
    // 同一次演练重复复查只保留最新结论
    apply('worse', 'd3');
    expect(issue.followUps.filter((f) => f.drillId === 'd3')).toHaveLength(1);
    expect(issue.followUps.find((f) => f.drillId === 'd3')?.result).toBe('worse');
  });
});
