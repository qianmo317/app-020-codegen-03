/**
 * 疏散演练统计验收用例：
 * - 段用时 = 相邻关键节点通过时刻之差（含开始→首节点、末节点→结束）
 * - 全程最慢段跨楼层选取；缺记跳过、倒挂报错
 * - 多次演练：楼层用时趋势、出口使用频次（同演练跨层共用出口只计 1 次）、垫底楼层、拥堵
 * - 问题挂房间/设施并跨演练复查
 */
import { describe, it, expect } from 'vitest';
import type { Drill, DrillFloorRecord, DrillNode } from '../src/model';
import {
  blockageCounts,
  drillFloorTimings,
  drillSlowestSegment,
  drillWarnings,
  exitUsageStats,
  floorDurationTrend,
  floorFinishOrder,
  floorTiming,
  followUpsForDrill,
  fmtDuration,
  lastFinishedFloor,
  lastPlaceCounts,
  openIssuesAt,
  parseClockMs,
} from '../src/lib/drills';

const D = '2026-09-20';
const t = (hhmm: string) => `${D}T${hhmm}`;
const sec = (hhmmss: string) => `${D}T${hhmmss}`;

let nseq = 0;
function node(kind: DrillNode['kind'], label: string, time: string, extra?: Partial<DrillNode>): DrillNode {
  return { id: `n${nseq++}`, kind, label, time, ...extra };
}

function rec(floorId: string, patch: Partial<DrillFloorRecord> = {}): DrillFloorRecord {
  return {
    floorId,
    commander: '',
    participants: null,
    startedAt: '',
    completedAt: '',
    blocked: false,
    nodes: [],
    ...patch,
  };
}

function drill(id: string, date: string, floors: DrillFloorRecord[], issues: Drill['issues'] = []): Drill {
  return {
    id,
    buildingId: 'b1',
    date,
    startedAt: `${date}T09:00`,
    participants: 100,
    fireOrigin: { floorId: floors[0]?.floorId },
    floors,
    issues,
    createdAt: new Date(`${date}T08:00:00`).toISOString(),
  };
}

describe('时间解析与格式化', () => {
  it('T1 仅分到分与精确到秒都可解析；非法/越界返回 null', () => {
    expect(parseClockMs(t('09:00'))).toBe(9 * 3600_000);
    expect(parseClockMs(sec('09:00:30'))).toBe(9 * 3600_000 + 30_000);
    expect(parseClockMs('')).toBeNull();
    expect(parseClockMs(`${D}T24:00`)).toBeNull();
    expect(parseClockMs(`${D}T09:60`)).toBeNull();
  });

  it('T2 fmtDuration mm:ss / h:mm:ss / —', () => {
    expect(fmtDuration(75_000)).toBe('01:15');
    expect(fmtDuration(3725_000)).toBe('1:02:05');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(-1)).toBe('—');
  });
});

describe('floorTiming（楼层段用时）', () => {
  it('F1 开始→节点1→节点2→结束 逐段作差，total=结束-开始', () => {
    const r = rec('f1', {
      startedAt: t('09:00'),
      completedAt: t('09:04'),
      nodes: [
        node('stair', '东楼梯口', t('09:01')),
        node('exit', '东门', t('09:03')),
      ],
    });
    const tm = floorTiming(r);
    expect(tm.totalMs).toBe(240_000);
    expect(tm.segments.map((s) => s.durationMs)).toEqual([60_000, 120_000, 60_000]);
    expect(tm.slowest?.durationMs).toBe(120_000);
    expect(tm.slowest?.fromLabel).toBe('东楼梯口');
    expect(tm.anomalies).toBe(0);
  });

  it('F2 无节点时整层为一段（开始→结束）', () => {
    const tm = floorTiming(rec('f1', { startedAt: t('09:00'), completedAt: t('09:02:30') }));
    expect(tm.segments).toHaveLength(1);
    expect(tm.segments[0].kind).toBe('floor');
    expect(tm.totalMs).toBe(150_000);
  });

  it('F3 节点缺记通过时间：相邻段跳过，其余段与 total 仍可算', () => {
    const r = rec('f1', {
      startedAt: t('09:00'),
      completedAt: t('09:05'),
      nodes: [node('stair', '中楼梯口', ''), node('exit', '西门', t('09:04'))],
    });
    const tm = floorTiming(r);
    // start 段（开始→未记时刻节点）与 节点→节点 段均跳过；只剩 西门→结束
    expect(tm.segments).toHaveLength(1);
    expect(tm.segments[0].kind).toBe('end');
    expect(tm.segments[0].durationMs).toBe(60_000);
    expect(tm.totalMs).toBe(300_000);
    expect(tm.missing).toBe(false);
  });

  it('F4 时间倒挂（负值）保留为 anomalous 段并计数，不参与最慢', () => {
    const r = rec('f1', {
      startedAt: t('09:05'),
      completedAt: t('09:06'),
      nodes: [node('stair', '东楼梯口', t('09:04'))],
    });
    const tm = floorTiming(r);
    expect(tm.segments[0].anomalous).toBe(true);
    expect(tm.anomalies).toBe(1);
    // 末节点→结束为正常段（120s），倒挂段不参与最慢
    expect(tm.slowest?.durationMs).toBe(120_000);
  });

  it('F5 开始/结束缺失：missing=true 且 total 为空', () => {
    const tm = floorTiming(rec('f1', { startedAt: '', completedAt: t('09:06') }));
    expect(tm.missing).toBe(true);
    expect(tm.totalMs).toBeNull();
  });
});

describe('drillSlowestSegment（全程最慢段，跨楼层）', () => {
  it('SLOW1 在多层所有段中取最长，报出楼层与段端点', () => {
    const d = drill('d1', D, [
      rec('f2', {
        startedAt: t('09:00'),
        completedAt: t('09:03'),
        nodes: [node('stair', '东楼梯口', t('09:02'))], // start 120s, end 60s
      }),
      rec('f1', {
        startedAt: t('09:03'),
        completedAt: t('09:09'),
        nodes: [
          node('stair', '东楼梯口', t('09:03:30')),
          node('exit', '东门', t('09:08')), // 楼梯口→东门 4:30 = 270s 最慢
        ],
      }),
    ]);
    const slow = drillSlowestSegment(d)!;
    expect(slow.floorId).toBe('f1');
    expect(slow.segment.fromLabel).toBe('东楼梯口');
    expect(slow.segment.toLabel).toBe('东门');
    expect(slow.segment.durationMs).toBe(270_000);
  });

  it('SLOW2 相邻层同名楼梯口：上层 end 段标记为跨层楼梯段', () => {
    const d = drill('d1', D, [
      rec('f2', {
        startedAt: t('09:00'),
        completedAt: t('09:02'),
        nodes: [node('stair', '东楼梯口', t('09:01'))], // end: 东楼梯口→结束 60s
      }),
      rec('f1', {
        startedAt: t('09:02'),
        completedAt: t('09:03'),
        nodes: [
          node('stair', '东楼梯口', t('09:02:10')),
          node('exit', '东门', t('09:02:40')),
        ],
      }),
    ]);
    const slow = drillSlowestSegment(d)!;
    // 上层（f2）的 end 段即跨层楼梯段，在全程 timing 上标记
    const crossSeg = drillFloorTimings(d).get('f2')!.segments.find((s) => s.crossFloor);
    expect(crossSeg).toBeDefined();
    expect(crossSeg?.kind).toBe('end');
    expect(slow).toBeTruthy();
  });

  it('SLOW3 全空数据返回 null', () => {
    expect(drillSlowestSegment(drill('d', D, []))).toBeNull();
  });
});

describe('楼层完成名次', () => {
  it('R1 lastFinishedFloor 取结束时刻最晚者；缺时刻层不参与', () => {
    const d = drill('d1', D, [
      rec('f1', { completedAt: t('09:05') }),
      rec('f2', { completedAt: t('09:08') }),
      rec('f3', { completedAt: '' }),
    ]);
    expect(lastFinishedFloor(d)).toBe('f2');
    expect(floorFinishOrder(d)).toEqual(['f1', 'f2']);
  });
});

describe('多次演练并排统计', () => {
  const drills: Drill[] = [
    drill('d1', '2026-09-01', [
      rec('f1', {
        startedAt: t('09:00'),
        completedAt: `${'2026-09-01'}T09:05`,
        blocked: true,
        blockedNote: '东门堆物',
        nodes: [
          node('stair', '东楼梯口', '2026-09-01T09:02'),
          node('exit', 'EXIT-01', '2026-09-01T09:04', { exitFacilityId: 'fac-east' }),
        ],
      }),
      rec('f2', {
        startedAt: '2026-09-01T09:00',
        completedAt: '2026-09-01T09:08',
        nodes: [node('exit', 'EXIT-01', '2026-09-01T09:07', { exitFacilityId: 'fac-east' })],
      }),
    ]),
    drill('d2', '2026-09-15', [
      rec('f1', {
        startedAt: '2026-09-15T10:00',
        completedAt: '2026-09-15T10:04',
        nodes: [
          node('stair', '西楼梯口', '2026-09-15T10:02'),
          node('exit', 'EXIT-02', '2026-09-15T10:03:30', { exitFacilityId: 'fac-west' }),
        ],
      }),
      rec('f2', {
        startedAt: '2026-09-15T10:00',
        completedAt: '2026-09-15T10:07',
        nodes: [node('exit', 'EXIT-01', '2026-09-15T10:06', { exitFacilityId: 'fac-east' })],
      }),
    ]),
  ];

  it('TREND1 同一楼层历次用时按日期升序，含名次与拥堵标记', () => {
    const trend = floorDurationTrend(drills, 'f1');
    expect(trend.map((p) => p.drillId)).toEqual(['d1', 'd2']);
    expect(trend[0].durationMs).toBe(300_000);
    expect(trend[1].durationMs).toBe(240_000); // 变快了
    expect(trend[0].blocked).toBe(true);
    // d1：f1 先结束（第 1），f2 第 2；d2 同样 f1 第 1
    expect(trend[0].rank).toBe(1);
    expect(trend[1].rank).toBe(1);
    const trend2 = floorDurationTrend(drills, 'f2');
    expect(trend2.map((p) => p.rank)).toEqual([2, 2]);
  });

  it('EXIT1 出口使用频次：同演练多层共用只计 1 次，东门 2 次居首', () => {
    const usage = exitUsageStats(drills);
    const east = usage.find((u) => u.facilityId === 'fac-east')!;
    const west = usage.find((u) => u.facilityId === 'fac-west')!;
    expect(east.count).toBe(2); // d1 两层都走东门只计 1 + d2 的 f2 计 1
    expect(west.count).toBe(1);
    expect(usage[0].facilityId).toBe('fac-east'); // 用得最多排第一
  });

  it('EXIT2 只记录了通过时间的出口才计数', () => {
    const d = drill('d3', '2026-10-01', [
      rec('f1', { nodes: [node('exit', '北门', '')] }),
    ]);
    expect(exitUsageStats([d])).toEqual([]);
  });

  it('LAST1 哪层老排最后：f2 两次垫底 → count=2/2；单层演练不计', () => {
    const counts = lastPlaceCounts(drills);
    const f2 = counts.find((c) => c.floorId === 'f2')!;
    const f1 = counts.find((c) => c.floorId === 'f1')!;
    expect(f2.count).toBe(2);
    expect(f2.total).toBe(2);
    expect(f1.count).toBe(0);
    expect(counts[0].floorId).toBe('f2');
    // 单层不算垫底
    const single = lastPlaceCounts([drill('x', '2026-11-01', [rec('f1', { completedAt: '2026-11-01T09:01' })])]);
    expect(single[0].count).toBe(0);
  });

  it('BLOCK1 拥堵楼层聚合计数并保留历次堵点描述', () => {
    const b = blockageCounts(drills);
    expect(b).toHaveLength(1);
    expect(b[0].floorId).toBe('f1');
    expect(b[0].count).toBe(1);
    expect(b[0].notes[0]).toContain('东门堆物');
  });
});

describe('录入校验', () => {
  it('W1 缺指挥为 error；时间倒挂为 error；缺节点时间/起火点为 warning', () => {
    const d = drill('d1', D, [
      rec('f1', {
        commander: '',
        startedAt: t('09:10'),
        completedAt: t('09:05'), // 倒挂
        nodes: [node('exit', '东门', '')],
      }),
    ]);
    d.fireOrigin = {};
    const ws = drillWarnings(d);
    expect(ws.some((w) => w.level === 'error' && w.message.includes('疏散指挥'))).toBe(true);
    expect(ws.some((w) => w.level === 'error' && w.message.includes('时间倒挂'))).toBe(true);
    expect(ws.some((w) => w.level === 'warning' && w.message.includes('节点'))).toBe(true);
    expect(ws.some((w) => w.level === 'warning' && w.message.includes('起火点'))).toBe(true);
  });
});

describe('问题挂账与跨演练复查', () => {
  const issues: Drill['issues'] = [
    {
      id: 'i1', drillId: 'd1', description: '2F 东楼梯口防火门闭门器坏',
      floorId: 'f2', roomId: 'r201', foundAt: '2026-09-01', status: 'open',
    },
    {
      id: 'i2', drillId: 'd1', description: '1F 灭火器压力不足',
      floorId: 'f1', facilityId: 'fac-1', foundAt: '2026-09-01', status: 'open',
    },
  ];
  const d1 = drill('d1', '2026-09-01', [rec('f1'), rec('f2')], issues);
  const d2 = drill('d2', '2026-10-01', [rec('f1'), rec('f2')], []);

  it('I1 下次录入时 followUpsForDrill 带出此前所有 open 问题', () => {
    const fu = followUpsForDrill([d1, d2], d2);
    expect(fu.map((i) => i.id).sort()).toEqual(['i1', 'i2']);
    // 自己的问题不算复查项；未来日期的演练不算
    expect(followUpsForDrill([d1, d2], d1)).toHaveLength(0);
  });

  it('I2 在 d2 复查确认 i1 已改进后：d2 不再复查 i1；openIssuesAt(d1) 仍可见，openIssuesAt(d2) 不含', () => {
    const i1Resolved: Drill['issues'][number] = { ...issues[0], status: 'resolved', resolvedDrillId: 'd2', resolvedAt: '2026-10-01' };
    const d1b = { ...d1, issues: [i1Resolved, issues[1]] };
    expect(followUpsForDrill([d1b, d2], d2).map((i) => i.id)).toEqual(['i2']);
    expect(openIssuesAt([d1b, d2], 'd1').map((i) => i.id)).toContain('i1'); // 9/1 当时仍挂账
    expect(openIssuesAt([d1b, d2], 'd2').map((i) => i.id)).not.toContain('i1');
    expect(openIssuesAt([d1b, d2], 'd2').map((i) => i.id)).toContain('i2'); // i2 仍待改进
  });

  it('I3 标记 still_open（仍存在）：下次演练继续带出复查', () => {
    const i1Open: Drill['issues'][number] = { ...issues[0], followUpNote: '已报后勤未修' };
    const d1b = { ...d1, issues: [i1Open, issues[1]] };
    const d3 = drill('d3', '2026-11-01', [rec('f1')], []);
    expect(followUpsForDrill([d1b, d2, d3], d3).map((i) => i.id).sort()).toEqual(['i1', 'i2']);
  });
});
