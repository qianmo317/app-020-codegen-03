import { useMemo, useState } from 'react';
import type { DrillNode, IssueTarget, NodeKind, FollowUpResult } from '../model';
import { FOLLOWUP_LABELS, ISSUE_STATUS_LABELS, NODE_KIND_LABELS } from '../model';
import {
  addDrillNode,
  addFollowUp,
  addIssue,
  deleteIssue,
  moveDrillNode,
  patchDrill,
  patchDrillNode,
  patchFloorRecord,
  removeDrillNode,
  setIssueStatus,
  setNodePass,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  drillSegments,
  drillTotalSec,
  floorDurationSec,
  fmtDur,
  followUpAt,
  parseTimeToSec,
  resolveTargetLabel,
  slowestSegment,
} from '../lib/drills';

export function DrillDetailPage({ drillId }: { drillId: string }) {
  const drill = useStore((s) => s.drills.find((d) => d.id === drillId));
  const floors = useStore((s) => s.floors);
  const buildings = useStore((s) => s.buildings);
  const allDrills = useStore((s) => s.drills);
  const issues = useStore((s) => s.issues);

  const [newKind, setNewKind] = useState<NodeKind>('stair');
  const [newName, setNewName] = useState('');
  const [newFloorId, setNewFloorId] = useState('');
  const [newFacilityId, setNewFacilityId] = useState('');

  const [targetFloor, setTargetFloor] = useState('');
  const [targetType, setTargetType] = useState<'room' | 'facility' | 'other'>('room');
  const [targetRef, setTargetRef] = useState('');
  const [desc, setDesc] = useState('');

  const segments = useMemo(() => (drill ? drillSegments(drill) : []), [drill]);
  const slowest = useMemo(() => (drill ? slowestSegment(drill) : null), [drill]);

  if (!drill) return <div className="page">演练记录不存在。<Link to="/drills">返回演练列表</Link></div>;
  const building = buildings.find((b) => b.id === drill.buildingId);
  const bFloors = building
    ? building.floors.map((id) => floors[id]).filter(Boolean).sort((a, b) => b.level - a.level)
    : [];
  const recOf = (floorId: string) => drill.floors.find((r) => r.floorId === floorId);
  const passOf = (nodeId: string) => drill.passes.find((p) => p.nodeId === nodeId)?.at ?? '';

  const priorOpen = issues
    .filter(
      (i) =>
        i.buildingId === drill.buildingId &&
        i.drillId !== drill.id &&
        (i.status === 'open' || !!followUpAt(i, drill.id)), // 本次已复查过的保留显示，允许改判
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const thisDrillIssues = issues.filter((i) => i.drillId === drill.id);

  const targetFloorObj = floors[targetFloor];
  const addNode = () => {
    if (!newName.trim()) return;
    const node: Omit<DrillNode, 'id'> = {
      kind: newKind,
      name: newName.trim(),
      floorId: newFloorId || undefined,
      facilityId: newKind === 'exit' && newFacilityId ? newFacilityId : undefined,
    };
    addDrillNode(drill.id, node);
    setNewName('');
    setNewFacilityId('');
  };

  const submitIssue = () => {
    if (!desc.trim() || (targetType !== 'other' && !targetFloor)) return;
    let target: IssueTarget;
    if (targetType === 'room') {
      target = { kind: 'room', floorId: targetFloor, roomId: targetRef };
    } else if (targetType === 'facility') {
      target = { kind: 'facility', floorId: targetFloor, facilityId: targetRef };
    } else {
      target = { kind: 'other', floorId: targetFloor || undefined, label: targetRef || '楼道' };
    }
    addIssue(drill.buildingId, drill.id, target, desc.trim());
    setDesc('');
  };

  return (
    <div className="page" style={{ maxWidth: 1060 }}>
      <div className="crumb">
        <Link to="/drills">疏散演练</Link>
        {' / '}{building?.name ?? '未知建筑'} / {drill.date}
      </div>

      {/* ---------- 基本信息 ---------- */}
      <div className="section">
        <h3>演练概况</h3>
        <div className="toolbar">
          <label className="row">日期
            <input type="date" value={drill.date} onChange={(e) => patchDrill(drill.id, { date: e.target.value })} />
          </label>
          <label className="row">警报时间
            <input
              type="time" step="1" value={drill.alarmAt}
              onChange={(e) => patchDrill(drill.id, { alarmAt: e.target.value })}
            />
          </label>
          <label className="row">参演人数
            <input
              type="number" min={0} style={{ width: 90 }} value={drill.participants || ''}
              onChange={(e) => patchDrill(drill.id, { participants: Number(e.target.value) })}
            />
          </label>
          <label className="row">假设起火楼层
            <select
              value={drill.fireFloorId ?? ''}
              onChange={(e) => patchDrill(drill.id, { fireFloorId: e.target.value || undefined, fireRoomId: undefined })}
            >
              <option value="">—</option>
              {bFloors.map((f) => <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>)}
            </select>
          </label>
          {drill.fireFloorId && (
            <label className="row">起火房间
              <select
                value={drill.fireRoomId ?? ''}
                onChange={(e) => patchDrill(drill.id, { fireRoomId: e.target.value || undefined })}
              >
                <option value="">（仅楼层）</option>
                {floors[drill.fireFloorId]?.rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="row">
          <input
            placeholder="假设起火点描述，如：302 室配电箱旁废纸起火"
            value={drill.fireNote ?? ''}
            onChange={(e) => patchDrill(drill.id, { fireNote: e.target.value })}
            style={{ flex: 1 }}
          />
        </div>
        <div className="row">
          <input
            placeholder="本次演练总体备注"
            value={drill.note ?? ''}
            onChange={(e) => patchDrill(drill.id, { note: e.target.value })}
            style={{ flex: 1 }}
          />
        </div>
        <p className="hint">
          全程用时：<b>{fmtDur(drillTotalSec(drill))}</b>（最晚楼层结束 − 警报时间）
        </p>
      </div>

      {/* ---------- 各层记录 ---------- */}
      <div className="section">
        <h3>各层疏散记录</h3>
        <table className="table">
          <thead>
            <tr>
              <th>楼层</th>
              <th>疏散指挥</th>
              <th>开始</th>
              <th>结束</th>
              <th>实际用时</th>
              <th>堵在楼道口</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {bFloors.map((f) => {
              const rec = recOf(f.id) ?? { floorId: f.id, commander: '', blocked: false };
              const dur = floorDurationSec(rec);
              const invalidStart = !!rec.start && parseTimeToSec(rec.start) == null;
              const invalidEnd = !!rec.end && parseTimeToSec(rec.end) == null;
              return (
                <tr key={f.id} className={rec.blocked ? 'overdue-row' : ''}>
                  <td><b>{floorLabel(f.level)}</b></td>
                  <td>
                    <input
                      value={rec.commander}
                      placeholder="指挥姓名"
                      onChange={(e) => patchFloorRecord(drill.id, f.id, { commander: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="time" step="1" value={rec.start ?? ''}
                      className={invalidStart ? 'bad-input' : ''}
                      onChange={(e) => patchFloorRecord(drill.id, f.id, { start: e.target.value || undefined })}
                    />
                  </td>
                  <td>
                    <input
                      type="time" step="1" value={rec.end ?? ''}
                      className={invalidEnd ? 'bad-input' : ''}
                      onChange={(e) => patchFloorRecord(drill.id, f.id, { end: e.target.value || undefined })}
                    />
                  </td>
                  <td>
                    <b className={dur == null && rec.end ? 'bad' : ''}>{fmtDur(dur)}</b>
                    {dur != null && dur < 0 && <span className="bad"> 时间倒序</span>}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!rec.blocked}
                      onChange={(e) => patchFloorRecord(drill.id, f.id, { blocked: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      value={rec.note ?? ''}
                      placeholder="堵口位置/原因"
                      onChange={(e) => patchFloorRecord(drill.id, f.id, { note: e.target.value })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---------- 路线节点与通过时间 ---------- */}
      <div className="section">
        <h3>疏散路线关键节点（按通过顺序）</h3>
        <p className="hint">
          每个楼梯口/出口记一次通过时间；系统按顺序自动算各段用时，最慢的一段红色标出。
        </p>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>类型</th>
              <th>节点名称</th>
              <th>楼层</th>
              <th>通过时间</th>
              <th>上一段用时</th>
              <th style={{ width: 130 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="hint">0</td>
              <td />
              <td>警报（{drill.alarmAt}）</td>
              <td />
              <td>{drill.alarmAt}</td>
              <td className="hint">起点</td>
              <td />
            </tr>
            {drill.nodes.map((n, i) => {
              const seg = segments[i];
              const isSlow = slowest?.nodeId === n.id;
              return (
                <tr key={n.id} className={isSlow ? 'slowest-row' : ''}>
                  <td className="hint">{i + 1}</td>
                  <td>
                    <select
                      value={n.kind}
                      onChange={(e) => patchDrillNode(drill.id, n.id, { kind: e.target.value as NodeKind })}
                    >
                      {Object.entries(NODE_KIND_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={n.name} onChange={(e) => patchDrillNode(drill.id, n.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <select
                      value={n.floorId ?? ''}
                      onChange={(e) => patchDrillNode(drill.id, n.id, { floorId: e.target.value || undefined })}
                    >
                      <option value="">—</option>
                      {bFloors.map((f) => <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      type="time" step="1" value={passOf(n.id)}
                      onChange={(e) => setNodePass(drill.id, n.id, e.target.value || undefined)}
                    />
                  </td>
                  <td className={isSlow ? 'bad' : ''}>
                    {seg?.sec != null ? (
                      <b>{fmtDur(seg.sec)}{isSlow ? ' 最慢' : ''}</b>
                    ) : (
                      <span className="hint">—</span>
                    )}
                    <div className="hint">{seg?.from} → {n.name}</div>
                  </td>
                  <td>
                    <button title="前移" disabled={i === 0} onClick={() => moveDrillNode(drill.id, n.id, -1)}>↑</button>
                    <button title="后移" disabled={i === drill.nodes.length - 1} onClick={() => moveDrillNode(drill.id, n.id, 1)}>↓</button>
                    <button className="danger" title="删除" onClick={() => removeDrillNode(drill.id, n.id)}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {slowest && (
          <p style={{ marginTop: 8 }}>
            <span className="badge st-damaged">瓶颈</span>{' '}
            全程最慢段：<b>{slowest.from} → {slowest.to}</b>，用时 <b className="bad">{fmtDur(slowest.sec)}</b>
          </p>
        )}

        <div className="toolbar" style={{ marginTop: 10 }}>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as NodeKind)}>
            {Object.entries(NODE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input placeholder="节点名称，如 东楼梯口" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select value={newFloorId} onChange={(e) => { setNewFloorId(e.target.value); setNewFacilityId(''); }}>
            <option value="">所在楼层（可选）</option>
            {bFloors.map((f) => <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>)}
          </select>
          {newKind === 'exit' && newFloorId && (
            <select value={newFacilityId} onChange={(e) => setNewFacilityId(e.target.value)}>
              <option value="">关联出口设施（用于使用次数统计）</option>
              {floors[newFloorId]?.facilities.filter((x) => x.kind === 'exit').map((x) => (
                <option key={x.id} value={x.id}>{x.code}</option>
              ))}
            </select>
          )}
          <button onClick={addNode} disabled={!newName.trim()}>追加节点</button>
        </div>
      </div>

      {/* ---------- 上次遗留问题复查 ---------- */}
      {priorOpen.length > 0 && (
        <div className="section">
          <h3>上次问题本次复查</h3>
          <table className="table">
            <thead>
              <tr><th>位置</th><th>问题</th><th>本次复查结论</th><th>备注</th></tr>
            </thead>
            <tbody>
              {priorOpen.map((i) => {
                const fu = followUpAt(i, drill.id);
                return (
                  <tr key={i.id}>
                    <td>
                      <b>{resolveTargetLabel(i.target, floors)}</b>
                      {i.target.kind !== 'other' && (
                        <div className="hint"><Link to={`/floor/${i.target.floorId}`}>在图上查看 →</Link></div>
                      )}
                    </td>
                    <td>{i.description}</td>
                    <td>
                      <div className="segctrl">
                        {(['fixed', 'still', 'worse'] as FollowUpResult[]).map((r) => (
                          <button
                            key={r}
                            className={fu?.result === r ? 'on' : ''}
                            onClick={() => addFollowUp(i.id, drill.id, r)}
                          >
                            {FOLLOWUP_LABELS[r]}
                          </button>
                        ))}
                      </div>
                      {fu && i.status === 'fixed' && <div className="hint good">已标记整改完成</div>}
                    </td>
                    <td>
                      <input
                        placeholder="复查说明"
                        defaultValue={fu?.note ?? ''}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (fu && v !== (fu.note ?? '')) addFollowUp(i.id, drill.id, fu.result, v || undefined);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- 本次发现的问题，挂到具体房间/设施 ---------- */}
      <div className="section">
        <h3>本次发现的问题</h3>
        <div className="toolbar">
          <select value={targetFloor} onChange={(e) => { setTargetFloor(e.target.value); setTargetRef(''); }}>
            <option value="">选择楼层</option>
            {bFloors.map((f) => <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>)}
          </select>
          <select value={targetType} onChange={(e) => { setTargetType(e.target.value as typeof targetType); setTargetRef(''); }}>
            <option value="room">挂到房间</option>
            <option value="facility">挂到设施</option>
            <option value="other">其他位置（文字）</option>
          </select>
          {targetType === 'room' && targetFloorObj && (
            <select value={targetRef} onChange={(e) => setTargetRef(e.target.value)}>
              <option value="">选择房间</option>
              {targetFloorObj.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          {targetType === 'facility' && targetFloorObj && (
            <select value={targetRef} onChange={(e) => setTargetRef(e.target.value)}>
              <option value="">选择设施</option>
              {targetFloorObj.facilities.map((x) => (
                <option key={x.id} value={x.id}>{x.code}</option>
              ))}
            </select>
          )}
          {targetType === 'other' && (
            <input placeholder="位置描述，如 东楼梯口转角" value={targetRef} onChange={(e) => setTargetRef(e.target.value)} />
          )}
          <input
            placeholder="问题描述，如：安全出口指示灯不亮 / 楼道堆物"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button
            onClick={submitIssue}
            disabled={!desc.trim() || (targetType !== 'other' ? !targetRef : !targetFloor && !targetRef.trim())}
          >
            登记问题
          </button>
        </div>

        <table className="table">
          <thead>
            <tr><th>位置</th><th>问题</th><th>状态</th><th>复查轨迹</th><th style={{ width: 150 }}>操作</th></tr>
          </thead>
          <tbody>
            {thisDrillIssues.length === 0 && (
              <tr><td colSpan={5} className="hint">本次未登记问题。</td></tr>
            )}
            {thisDrillIssues.map((i) => (
              <tr key={i.id}>
                <td>
                  <b>{resolveTargetLabel(i.target, floors)}</b>
                  {i.target.kind !== 'other' && (
                    <div className="hint"><Link to={`/floor/${i.target.floorId}`}>在图上查看 →</Link></div>
                  )}
                </td>
                <td>{i.description}</td>
                <td><span className={`badge ${i.status === 'fixed' ? 'st-ok' : 'st-damaged'}`}>{ISSUE_STATUS_LABELS[i.status]}</span></td>
                <td>
                  {i.followUps.map((f) => (
                    <span key={f.drillId} className="checkrow">
                      <Link to={`/drill/${f.drillId}`}>
                        {allDrills.find((d) => d.id === f.drillId)?.date ?? '演练'}
                      </Link>
                      ：{FOLLOWUP_LABELS[f.result]}{f.note ? `（${f.note}）` : ''}
                    </span>
                  ))}
                  {i.followUps.length === 0 && <span className="hint">待下次演练复查</span>}
                </td>
                <td>
                  {i.status !== 'fixed' && <button onClick={() => setIssueStatus(i.id, 'fixed')}>标已整改</button>}
                  {i.status === 'open' && <button onClick={() => setIssueStatus(i.id, 'wontfix')}>不整改</button>}
                  <button className="danger" onClick={() => confirm('删除该问题记录？') && deleteIssue(i.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
