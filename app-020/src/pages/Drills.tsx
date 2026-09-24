import { useMemo, useState } from 'react';
import type { Drill } from '../model';
import { ISSUE_STATUS_LABELS } from '../model';
import {
  addDrill,
  deleteDrill,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  blockedRate,
  drillCompleteness,
  drillTotalSec,
  exitUsage,
  floorTrend,
  fmtDur,
  lastFloorRanking,
  resolveTargetLabel,
} from '../lib/drills';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 简易柱状条：同层历次用时并排，最快/最慢一眼可辨 */
function MiniBars({ values }: { values: (number | null)[] }) {
  const max = Math.max(1, ...values.filter((v): v is number => v != null));
  return (
    <span className="bars">
      {values.map((v, i) => (
        <span
          key={i}
          className="bar"
          title={fmtDur(v)}
          style={{ height: v == null ? 2 : Math.max(3, Math.round((v / max) * 22)) }}
        />
      ))}
    </span>
  );
}

export function DrillsPage({ buildingId }: { buildingId?: string }) {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const allDrills = useStore((s) => s.drills);
  const issues = useStore((s) => s.issues);
  const [selected, setSelected] = useState<string>(buildingId ?? 'all');
  const [date, setDate] = useState(today());
  const [alarmAt, setAlarmAt] = useState('09:00');
  const [participants, setParticipants] = useState(0);

  const building = buildings.find((b) => b.id === selected);
  const drills = useMemo(
    () =>
      allDrills
        .filter((d) => selected === 'all' || d.buildingId === selected)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [allDrills, selected],
  );
  const levelOf = (fid: string) => floors[fid]?.level;
  const buildingFloors = building
    ? building.floors.map((id) => floors[id]).filter(Boolean).sort((a, b) => b.level - a.level)
    : [];

  const ranking = useMemo(() => lastFloorRanking(drills, levelOf), [drills, floors]);
  const exits = useMemo(() => exitUsage(drills), [drills]);
  const openIssues = issues.filter(
    (i) => (selected === 'all' || i.buildingId === selected) && i.status === 'open',
  );

  return (
    <div className="page">
      <h2>疏散演练记录{building ? ` · ${building.name}` : ''}</h2>

      <div className="toolbar">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="all">全部建筑</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {building ? (
          <>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input
              type="time"
              value={alarmAt}
              step="1"
              onChange={(e) => setAlarmAt(e.target.value)}
              title="警报（假设起火）时间"
            />
            <input
              type="number"
              min={0}
              placeholder="参演人数"
              value={participants || ''}
              onChange={(e) => setParticipants(Number(e.target.value))}
              style={{ width: 100 }}
            />
            <button
              onClick={() => {
                const id = addDrill(building.id, {
                  date,
                  alarmAt: alarmAt || '09:00',
                  participants,
                });
                window.location.hash = `#/drill/${id}`;
              }}
            >
              新建演练
            </button>
          </>
        ) : (
          <span className="hint">选择某个建筑后可新建演练</span>
        )}
      </div>

      {drills.length === 0 && <p className="hint">还没有演练记录。</p>}

      {/* ---------- 多次演练并排对比 ---------- */}
      {drills.length > 0 && (
        <>
          <div className="section">
            <h3>历次演练并排对比</h3>
            <p className="hint">按日期从旧到新排列；全程用时 = 最晚楼层结束 − 警报时间。</p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>假设起火点</th>
                    <th>参演人数</th>
                    <th>数据完整度</th>
                    <th>全程用时</th>
                    <th>堵口楼层</th>
                    <th>最后撤离</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...drills].reverse().map((d) => {
                    const total = drillTotalSec(d);
                    const comp = drillCompleteness(d);
                    const blockedFloors = d.floors.filter((r) => r.blocked).map((r) => floors[r.floorId]?.level);
                    const last = lastFloorRanking([d], levelOf)[0];
                    return (
                      <DrillRow
                        key={d.id}
                        d={d}
                        total={total}
                        comp={comp}
                        blockedFloors={blockedFloors}
                        lastFloorLabel={last ? floorLabel(levelOf(last.floorId) ?? NaN) : '—'}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {buildingFloors.length > 0 && (
            <div className="section">
              <h3>同一楼层历次用时</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>楼层</th>
                    <th style={{ width: 120 }}>历次用时（秒→条形）</th>
                    <th>历次用时</th>
                    <th>堵口次数</th>
                    <th>趋势</th>
                  </tr>
                </thead>
                <tbody>
                  {buildingFloors.map((f) => {
                    const trend = floorTrend(drills, f.id);
                    const br = blockedRate(drills, f.id);
                    if (trend.length === 0) {
                      return (
                        <tr key={f.id}>
                          <td>{floorLabel(f.level)}</td>
                          <td colSpan={4} className="hint">无记录</td>
                        </tr>
                      );
                    }
                    const secs = trend.map((p) => p.sec);
                    const first = secs[0]!;
                    const lastSec = secs[secs.length - 1]!;
                    const delta = lastSec - first;
                    return (
                      <tr key={f.id}>
                        <td>{floorLabel(f.level)}</td>
                        <td><MiniBars values={secs} /></td>
                        <td>
                          {trend.map((p, i) => (
                            <span key={p.drillId} className={p.blocked ? 'bad' : ''}>
                              {i > 0 ? ' → ' : ''}{fmtDur(p.sec)}
                            </span>
                          ))}
                        </td>
                        <td className={br.blocked > 0 ? 'bad' : ''}>
                          {br.blocked}/{br.total}
                        </td>
                        <td>
                          {secs.length >= 2 ? (
                            <span className={delta < 0 ? 'good' : delta > 0 ? 'bad' : ''}>
                              {delta < 0 ? `快了 ${fmtDur(-delta)}` : delta > 0 ? `慢了 ${fmtDur(delta)}` : '持平'}
                            </span>
                          ) : (
                            <span className="hint">仅 1 次</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="twocol">
            <div className="section">
              <h3>出口使用次数</h3>
              {exits.length === 0 && <p className="hint">未记录出口通过时间。</p>}
              <table className="table">
                <thead>
                  <tr><th>出口</th><th>使用次数</th><th>占比</th></tr>
                </thead>
                <tbody>
                  {exits.map((e) => {
                    const totalUsed = exits.reduce((s, x) => s + x.count, 0);
                    return (
                      <tr key={e.key}>
                        <td>{e.name}</td>
                        <td className={e.count === Math.max(...exits.map((x) => x.count)) ? 'good' : ''}>
                          <b>{e.count}</b>
                        </td>
                        <td>{Math.round((e.count / totalUsed) * 100)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="section">
              <h3>老是排在最后的楼层</h3>
              {ranking.length === 0 && <p className="hint">缺少楼层结束时间。</p>}
              <table className="table">
                <thead>
                  <tr><th>楼层</th><th>垫底次数</th><th>最近一次</th></tr>
                </thead>
                <tbody>
                  {ranking.map((r) => (
                    <tr key={r.floorId}>
                      <td>{floors[r.floorId] ? floorLabel(floors[r.floorId].level) : '已删除楼层'}</td>
                      <td className="bad"><b>{r.count}</b></td>
                      <td>{r.lastDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ---------- 待整改问题（下次演练重点复查） ---------- */}
      <div className="section">
        <h3>待整改问题（下次演练重点复查）</h3>
        {openIssues.length === 0 ? (
          <p className="hint">没有待整改问题。</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>位置</th><th>问题</th><th>状态</th><th>发现于</th></tr>
            </thead>
            <tbody>
              {openIssues.map((i) => (
                <tr key={i.id}>
                  <td><b>{resolveTargetLabel(i.target, floors)}</b></td>
                  <td>{i.description}</td>
                  <td><span className="badge st-damaged">{ISSUE_STATUS_LABELS[i.status]}</span></td>
                  <td>
                    {i.drillId ? (
                      <Link to={`/drill/${i.drillId}`}>
                        {allDrills.find((d) => d.id === i.drillId)?.date ?? '演练'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DrillRow({
  d,
  total,
  comp,
  blockedFloors,
  lastFloorLabel,
}: {
  d: Drill;
  total: number | null;
  comp: { done: number; total: number };
  blockedFloors: number[];
  lastFloorLabel: string;
}) {
  const floorsMap = useStore((s) => s.floors);
  const fireFloor = d.fireFloorId ? floorsMap[d.fireFloorId] : undefined;
  return (
    <tr>
      <td><Link to={`/drill/${d.id}`}>{d.date}</Link></td>
      <td>
        {fireFloor ? floorLabel(fireFloor.level) : '—'}
        {d.fireNote ? <span className="hint"> {d.fireNote}</span> : ''}
      </td>
      <td>{d.participants}</td>
      <td className={comp.done < comp.total ? 'warn' : 'good'}>
        {comp.done}/{comp.total} 层
      </td>
      <td><b>{fmtDur(total)}</b></td>
      <td className={blockedFloors.length ? 'bad' : ''}>
        {blockedFloors.length ? blockedFloors.map((l) => floorLabel(l)).join('、') : '无'}
      </td>
      <td>{lastFloorLabel}</td>
      <td>
        <Link className="btn" to={`/drill/${d.id}`}>打开</Link>{' '}
        <button
          className="danger"
          onClick={() => confirm(`删除 ${d.date} 的演练记录？（问题记录保留）`) && deleteDrill(d.id)}
        >
          删除
        </button>
      </td>
    </tr>
  );
}
