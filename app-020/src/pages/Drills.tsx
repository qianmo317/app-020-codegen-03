import { useMemo, useState } from 'react';
import {
  addDrill,
  deleteDrill,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  blockageCounts,
  drillSlowestSegment,
  exitUsageStats,
  floorDurationTrend,
  floorFinishOrder,
  floorTiming,
  fmtDuration,
  lastFinishedFloor,
  lastPlaceCounts,
} from '../lib/drills';
import { DRILL_ISSUE_STATUS_LABELS } from '../model';
import { download } from './Facilities';

function today(): string {
  const d = new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 简单条形：宽度按 max 归一 */
function Bar({ value, max, label, extra }: { value: number; max: number; label: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${max > 0 ? Math.max(4, (value / max) * 100) : 0}%` }} />
      </span>
      <span className="bar-val">{extra ?? value}</span>
    </div>
  );
}

export function DrillsPage({ buildingId }: { buildingId?: string }) {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const allDrills = useStore((s) => s.drills);
  const [pickedBuilding, setPickedBuilding] = useState(buildingId ?? 'all');
  const [date, setDate] = useState(today());
  const [trendFloor, setTrendFloor] = useState('');

  const drills = useMemo(
    () =>
      allDrills
        .filter((d) => pickedBuilding === 'all' || d.buildingId === pickedBuilding)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [allDrills, pickedBuilding],
  );

  const buildingName = (id: string) => buildings.find((b) => b.id === id)?.name ?? '（建筑已删除）';
  const flLabel = (id: string) => {
    const f = floors[id];
    return f ? floorLabel(f.level) : '（楼层已删除）';
  };
  const exitName = (facilityId?: string, fallback?: string, floorId?: string) => {
    if (facilityId) {
      for (const f of Object.values(floors)) {
        const fac = f.facilities.find((x) => x.id === facilityId);
        if (fac) return fac.code;
      }
    }
    return fallback || (floorId ? `${flLabel(floorId)} 出口` : '出口');
  };

  // ---------- 多次演练统计 ----------
  const usage = useMemo(() => exitUsageStats(drills), [drills]);
  const lastCounts = useMemo(() => lastPlaceCounts(drills), [drills]);
  const blocks = useMemo(() => blockageCounts(drills), [drills]);

  const slowestPerDrill = useMemo(
    () =>
      drills
        .map((d) => ({ drill: d, slow: drillSlowestSegment(d), last: lastFinishedFloor(d) }))
        .filter((x) => x.slow),
    [drills],
  );
  const globalSlow = slowestPerDrill.sort((a, b) => b.slow!.segment.durationMs - a.slow!.segment.durationMs)[0] ?? null;

  // 趋势图可选楼层：所选建筑全部楼层
  const buildingIds = pickedBuilding === 'all' ? buildings.map((b) => b.id) : [pickedBuilding];
  const floorOptions = buildingIds.flatMap((bid) => buildings.find((b) => b.id === bid)?.floors ?? []);
  const trendFloorId = trendFloor || floorOptions[0] || '';
  const trend = useMemo(
    () => (trendFloorId ? floorDurationTrend(drills, trendFloorId) : []),
    [drills, trendFloorId],
  );
  const trendMax = Math.max(1, ...trend.map((t) => t.durationMs ?? 0));

  const fireText = (d: (typeof drills)[number]) => {
    if (d.fireOrigin.floorId) {
      const f = floors[d.fireOrigin.floorId];
      const room = f?.rooms.find((r) => r.id === d.fireOrigin.roomId);
      return [f ? floorLabel(f.level) : '', room?.name ?? '', d.fireOrigin.detail ?? ''].filter(Boolean).join(' · ') || flLabel(d.fireOrigin.floorId);
    }
    return d.fireOrigin.detail?.trim() || '—';
  };

  const exportCsv = () => {
    const header = '日期,建筑,演练名称,参演人数,假设起火点,楼层,疏散指挥,开始,结束,实际用时,堵在楼道口,最慢段,全程最慢段,垫底楼层,待改进问题';
    const lines: string[] = [];
    for (const d of [...drills].sort((a, b) => a.date.localeCompare(b.date))) {
      const slow = drillSlowestSegment(d);
      const last = lastFinishedFloor(d);
      const openN = d.issues.filter((i) => i.status === 'open').length;
      for (const r of d.floors) {
        const t = floorTiming(r);
        const localSlow = t.slowest;
        const isGlobalSlow =
          slow != null &&
          slow.floorId === r.floorId &&
          localSlow != null &&
          slow.segment.fromLabel === localSlow.fromLabel &&
          slow.segment.toLabel === localSlow.toLabel &&
          slow.segment.durationMs === localSlow.durationMs;
        lines.push(
          [
            d.date,
            buildingName(d.buildingId),
            d.name ?? '',
            d.participants ?? '',
            fireText(d),
            flLabel(r.floorId),
            r.commander,
            r.startedAt.replace('T', ' '),
            r.completedAt.replace('T', ' '),
            t.totalMs != null ? Math.round(t.totalMs / 1000) : '',
            r.blocked ? '是' : '否',
            localSlow ? `${localSlow.fromLabel}→${localSlow.toLabel} ${Math.round(localSlow.durationMs / 1000)}秒` : '',
            isGlobalSlow ? '★' : '',
            last === r.floorId ? '是' : '',
            r === d.floors[0] ? openN : '',
          ].join(','),
        );
      }
    }
    download(`疏散演练统计_${today()}.csv`, [header, ...lines].join('\n'));
  };

  return (
    <div className="page">
      <h2>疏散演练记录与统计</h2>
      <div className="toolbar">
        <select value={pickedBuilding} onChange={(e) => { setPickedBuilding(e.target.value); setTrendFloor(''); }}>
          <option value="all">全部建筑</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button
          disabled={pickedBuilding === 'all' || !date}
          onClick={() => {
            const id = addDrill(pickedBuilding, date);
            window.location.hash = `#/drill/${id}`;
          }}
        >
          登记新演练
        </button>
        <button onClick={exportCsv} disabled={!drills.length}>导出统计 CSV</button>
        {pickedBuilding === 'all' && <span className="hint">先选建筑再登记演练</span>}
      </div>

      {drills.length === 0 && (
        <p className="hint">还没有演练记录。选择建筑与日期后点「登记新演练」，逐层补录时间与节点。</p>
      )}

      {/* ---------- 多次演练并排看 ---------- */}
      {drills.length > 0 && (
        <>
          <div className="statgrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <div className="stat">
              <label>演练次数</label>
              <b>{drills.length}</b>
            </div>
            <div className="stat">
              <label>累计参演人次</label>
              <b>{drills.reduce((s, d) => s + (d.participants ?? 0), 0)}</b>
            </div>
            <div className="stat">
              <label>待改进问题</label>
              <b className={drills.some((d) => d.issues.some((i) => i.status === 'open')) ? 'bad' : ''}>
                {drills.reduce((s, d) => s + d.issues.filter((i) => i.status === 'open').length, 0)}
              </b>
            </div>
            <div className="stat">
              <label>楼道口拥堵次数</label>
              <b className={blocks.length ? 'bad' : ''}>{blocks.reduce((s, b) => s + b.count, 0)}</b>
            </div>
          </div>

          <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 12 }}>
            <div className="card">
              <div className="cardtitle">出口使用频次</div>
              <div className="hint">哪个出口被用得最多（按通过出口节点的演练数）</div>
              <div className="bars">
                {usage.length === 0 && <span className="hint">暂无出口节点记录</span>}
                {usage.slice(0, 8).map((u) => (
                  <Bar
                    key={u.key}
                    value={u.count}
                    max={usage[0]?.count ?? 1}
                    label={exitName(u.facilityId, u.label, u.floorId)}
                    extra={`${u.count} 次`}
                  />
                ))}
              </div>
            </div>

            <div className="card">
              <div className="cardtitle">哪层老排最后</div>
              <div className="hint">按各层结束时刻排名（单层演练不计垫底）</div>
              <div className="bars">
                {lastCounts.length === 0 && <span className="hint">暂无结束时间</span>}
                {lastCounts.slice(0, 8).map((c) => (
                  <Bar
                    key={c.floorId}
                    value={c.count}
                    max={Math.max(1, ...lastCounts.map((x) => x.count))}
                    label={flLabel(c.floorId)}
                    extra={`${c.count}/${c.total} 次`}
                  />
                ))}
              </div>
            </div>

            <div className="card">
              <div className="cardtitle">全程最慢的一段</div>
              <div className="hint">历次演练各节点段用时最大值</div>
              {globalSlow ? (
                <div className="slowest-box">
                  <b className="bad">{fmtDuration(globalSlow.slow!.segment.durationMs)}</b>
                  <span>
                    {globalSlow.drill.date} · {flLabel(globalSlow.slow!.floorId)} ·
                    {globalSlow.slow!.segment.fromLabel} → {globalSlow.slow!.segment.toLabel}
                    {globalSlow.slow!.segment.crossFloor ? '（楼梯段）' : ''}
                  </span>
                </div>
              ) : (
                <span className="hint">暂无节点时间</span>
              )}
              <div className="stack" style={{ marginTop: 8 }}>
                {slowestPerDrill.slice(0, 5).map(({ drill, slow }) => (
                  <div key={drill.id} className="hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{drill.date} {flLabel(slow!.floorId)} {slow!.segment.fromLabel}→{slow!.segment.toLabel}</span>
                    <b>{fmtDuration(slow!.segment.durationMs)}</b>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="cardtitle">拥堵在楼道口</div>
              <div className="hint">记录「堵在楼道口」的楼层与次数</div>
              <div className="bars">
                {blocks.length === 0 && <span className="hint">无拥堵记录</span>}
                {blocks.map((b) => (
                  <div key={b.floorId} className="bar-row" title={b.notes.join('\n')}>
                    <span className="bar-label">{flLabel(b.floorId)}</span>
                    <span className="bar-track">
                      <span className="bar-fill bad-fill" style={{ width: `${Math.max(4, (b.count / Math.max(1, ...blocks.map((x) => x.count))) * 100)}%` }} />
                    </span>
                    <span className="bar-val">{b.count} 次</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 同一楼层历次用时趋势 */}
          <div className="section">
            <div className="toolbar" style={{ margin: 0 }}>
              <b>同一楼层历次用时怎么变</b>
              <select value={trendFloorId} onChange={(e) => setTrendFloor(e.target.value)}>
                {floorOptions.map((fid) => (
                  <option key={fid} value={fid}>{buildingName(floors[fid]?.buildingId ?? '')} · {flLabel(fid)}</option>
                ))}
              </select>
            </div>
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>演练日期</th><th>用时</th><th>名次</th><th>楼道口拥堵</th><th>趋势</th><th>演练</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.drillId}>
                    <td>{t.date}</td>
                    <td><b>{fmtDuration(t.durationMs)}</b></td>
                    <td>{t.rank == null ? '—' : `第 ${t.rank} 名`}</td>
                    <td>{t.blocked ? <span className="badge st-expired">堵</span> : '否'}</td>
                    <td style={{ minWidth: 180 }}>
                      <span className="bar-track" style={{ display: 'inline-block', width: 160 }}>
                        <span className="bar-fill" style={{ width: `${((t.durationMs ?? 0) / trendMax) * 100}%` }} />
                      </span>
                    </td>
                    <td><Link to={`/drill/${t.drillId}`}>打开</Link></td>
                  </tr>
                ))}
                {trend.length === 0 && <tr><td colSpan={6} className="hint">该楼层未参加任何演练</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---------- 演练列表 ---------- */}
      <h2 style={{ marginTop: 18 }}>历次演练</h2>
      <table className="table">
        <thead>
          <tr>
            <th>日期</th><th>建筑</th><th>名称/场景</th><th>参演人数</th><th>假设起火点</th>
            <th>楼层数</th><th>最后撤离</th><th>问题</th><th />
          </tr>
        </thead>
        <tbody>
          {drills.map((d) => {
            const order = floorFinishOrder(d);
            const last = order[order.length - 1];
            const openN = d.issues.filter((i) => i.status === 'open').length;
            const resolvedN = d.issues.filter((i) => i.status === 'resolved').length;
            return (
              <tr key={d.id}>
                <td><Link to={`/drill/${d.id}`}>{d.date}</Link></td>
                <td>{buildingName(d.buildingId)}</td>
                <td>{d.name || d.scenario || <span className="hint">—</span>}</td>
                <td>{d.participants ?? '—'}</td>
                <td>{fireText(d)}</td>
                <td>{d.floors.filter((r) => r.startedAt || r.completedAt).length}/{d.floors.length}</td>
                <td>{last ? flLabel(last) : '—'}</td>
                <td>
                  {openN > 0 && <span className="badge st-expired">待改进 {openN}</span>}{' '}
                  {resolvedN > 0 && <span className="badge st-ok">已改进 {resolvedN}</span>}
                  {d.issues.length === 0 && <span className="hint">—</span>}
                </td>
                <td>
                  <Link className="btn" to={`/drill/${d.id}`}>录入/查看</Link>{' '}
                  <button
                    className="danger"
                    onClick={() => confirm(`删除 ${d.date} 的演练记录？（其中登记的问题也会一并删除）`) && deleteDrill(d.id)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        问题状态：{Object.entries(DRILL_ISSUE_STATUS_LABELS).map(([k, v]) => `${v}(${k})`).join(' / ')}；
        在某次演练里登记的问题会挂到具体房间/设施，下一次录入时自动列入复查清单。
      </p>
    </div>
  );
}
