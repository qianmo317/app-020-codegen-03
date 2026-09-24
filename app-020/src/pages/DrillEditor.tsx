import { useMemo, useState } from 'react';
import {
  addDrillIssue,
  removeDrillIssue,
  resolveDrillIssue,
  setDrillFloorRecord,
  addDrillNode,
  moveDrillNode,
  removeDrillNode,
  updateDrill,
  updateDrillNode,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  DRILL_ISSUE_STATUS_LABELS,
  DRILL_NODE_LABELS,
  type DrillIssue,
  type DrillNode,
} from '../model';
import {
  drillFloorTimings,
  drillWarnings,
  floorFinishOrder,
  followUpsForDrill,
  fmtDuration,
  issueTarget,
  type FloorTiming,
} from '../lib/drills';

function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <input
      type="datetime-local"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: 175 }}
    />
  );
}

function NumInput({ value, onChange, placeholder, style }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; style?: React.CSSProperties }) {
  return (
    <input
      type="number"
      min={0}
      style={style}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
    />
  );
}

/** 节点上拉选出口：列出该层已布置的安全出口设施 */
function ExitNodeFields({
  drillId,
  floorId,
  node,
}: {
  drillId: string;
  floorId: string;
  node: DrillNode;
}) {
  const floor = useStore((s) => s.floors[floorId]);
  const exits = floor?.facilities.filter((f) => f.kind === 'exit') ?? [];
  return (
    <>
      {exits.length > 0 && (
        <select
          value={node.exitFacilityId ?? ''}
          onChange={(e) => {
            const fid = e.target.value || undefined;
            const fac = exits.find((x) => x.id === fid);
            updateDrillNode(drillId, floorId, node.id, {
              exitFacilityId: fid,
              label: fid ? fac!.code : node.label,
            });
          }}
        >
          <option value="">自定义出口名…</option>
          {exits.map((f) => (
            <option key={f.id} value={f.id}>{f.code}</option>
          ))}
        </select>
      )}
      <input
        placeholder="出口名称"
        value={node.exitFacilityId ? '' : node.label}
        disabled={!!node.exitFacilityId}
        onChange={(e) => updateDrillNode(drillId, floorId, node.id, { label: e.target.value, exitFacilityId: undefined })}
        style={{ width: 110 }}
      />
    </>
  );
}

function NodeRow({
  drillId,
  floorId,
  node,
  index,
  total,
}: {
  drillId: string;
  floorId: string;
  node: DrillNode;
  index: number;
  total: number;
}) {
  return (
    <tr>
      <td className="hint">{index + 1}</td>
      <td>
        <select
          value={node.kind}
          onChange={(e) => updateDrillNode(drillId, floorId, node.id, { kind: e.target.value as DrillNode['kind'] })}
        >
          <option value="stair">{DRILL_NODE_LABELS.stair}</option>
          <option value="exit">{DRILL_NODE_LABELS.exit}</option>
        </select>
      </td>
      <td>
        {node.kind === 'stair' ? (
          <input
            placeholder="如：东楼梯口"
            value={node.label}
            onChange={(e) => updateDrillNode(drillId, floorId, node.id, { label: e.target.value })}
            style={{ width: 130 }}
          />
        ) : (
          <ExitNodeFields drillId={drillId} floorId={floorId} node={node} />
        )}
      </td>
      <td>
        <TimeInput label="通过时间" value={node.time} onChange={(v) => updateDrillNode(drillId, floorId, node.id, { time: v })} />
      </td>
      <td>
        <button disabled={index === 0} title="上移" onClick={() => moveDrillNode(drillId, floorId, node.id, -1)}>↑</button>{' '}
        <button disabled={index === total - 1} title="下移" onClick={() => moveDrillNode(drillId, floorId, node.id, 1)}>↓</button>{' '}
        <button className="danger" title="删除节点" onClick={() => removeDrillNode(drillId, floorId, node.id)}>×</button>
      </td>
    </tr>
  );
}

// ---------- 问题编辑 ----------

type FloorLite = {
  id: string;
  level: number;
  rooms: { id: string; name: string }[];
  facilities: { id: string; code: string; kind?: string }[];
};

function issueTargetText(issue: DrillIssue, floors: Record<string, FloorLite>): string {
  const t = issueTarget(issue);
  if (t.kind === 'none') return '未定位';
  const f = floors[t.floorId];
  const fl = f ? floorLabel(f.level) : '（楼层已删）';
  if (t.kind === 'floor') return fl;
  if (t.kind === 'room') {
    const r = f?.rooms.find((x) => x.id === t.roomId);
    return `${fl} · ${r?.name ?? '（房间已删）'}`;
  }
  const fac = f?.facilities.find((x) => x.id === t.facilityId);
  return `${fl} · ${fac?.code ?? '（设施已删）'}`;
}

function IssueTargetSelect({
  floorId,
  roomId,
  facilityId,
  onChange,
  floorOptions,
}: {
  floorId?: string;
  roomId?: string;
  facilityId?: string;
  onChange: (v: { floorId?: string; roomId?: string; facilityId?: string }) => void;
  floorOptions: FloorLite[];
}) {
  const floor = floorOptions.find((f) => f.id === floorId);
  return (
    <span className="row" style={{ flex: 'none' }}>
      <select value={floorId ?? ''} onChange={(e) => onChange({ floorId: e.target.value || undefined, roomId: undefined, facilityId: undefined })}>
        <option value="">不定位楼层</option>
        {floorOptions.map((f) => (
          <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>
        ))}
      </select>
      {floor && (
        <select value={facilityId ? `fac:${facilityId}` : roomId ? `room:${roomId}` : ''} onChange={(e) => {
          const v = e.target.value;
          if (!v) return onChange({ floorId });
          if (v.startsWith('fac:')) return onChange({ floorId, facilityId: v.slice(4) });
          onChange({ floorId, roomId: v.slice(5) });
        }}>
          <option value="">仅楼层/楼梯间</option>
          <optgroup label="房间">
            {floor.rooms.map((r) => <option key={r.id} value={`room:${r.id}`}>{r.name}</option>)}
          </optgroup>
          <optgroup label="设施">
            {floor.facilities.map((f2) => <option key={f2.id} value={`fac:${f2.id}`}>{f2.code}</option>)}
          </optgroup>
        </select>
      )}
    </span>
  );
}

function IssueForm({ drillId, buildingFloorIds, date }: { drillId: string; buildingFloorIds: string[]; date: string }) {
  const floors = useStore((s) => s.floors);
  const [desc, setDesc] = useState('');
  const [floorId, setFloorId] = useState<string | undefined>(buildingFloorIds[0]);
  const [roomId, setRoomId] = useState<string | undefined>();
  const [facilityId, setFacilityId] = useState<string | undefined>();

  const floorOptions: FloorLite[] = buildingFloorIds
    .map((fid) => floors[fid])
    .filter(Boolean)
    .map((f) => ({ id: f.id, level: f.level, rooms: f.rooms, facilities: f.facilities }));

  const submit = () => {
    if (!desc.trim()) return;
    addDrillIssue(drillId, {
      description: desc.trim(),
      floorId,
      roomId,
      facilityId,
      foundAt: date,
    });
    setDesc('');
    setRoomId(undefined);
    setFacilityId(undefined);
  };

  return (
    <div className="stack">
      <textarea
        rows={2}
        placeholder="发现的问题，如：2F 东楼梯口防火门闭门器失效，疏散时门回弹堵人"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <IssueTargetSelect
        floorId={floorId}
        roomId={roomId}
        facilityId={facilityId}
        floorOptions={floorOptions}
        onChange={(v) => { setFloorId(v.floorId); setRoomId(v.roomId); setFacilityId(v.facilityId); }}
      />
      <div>
        <button disabled={!desc.trim()} onClick={submit}>登记问题（挂到房间/设施）</button>
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  drillDate,
  allFloors,
  currentDrillId,
}: {
  issue: DrillIssue;
  drillDate: string;
  allFloors: Record<string, FloorLite>;
  currentDrillId: string;
}) {
  const [mode, setMode] = useState<'view' | 'note'>('view');
  const [note, setNote] = useState('');
  const badge = issue.status === 'open' ? 'st-expired' : issue.status === 'resolved' ? 'st-ok' : '';
  return (
    <div className={`item issue-${issue.status}`}>
      <span className={`dot ${issue.status === 'open' ? 'error' : 'warning'}`} />
      <div style={{ flex: 1 }}>
        <div>
          <b>{issue.description}</b>{' '}
          <span className={`badge ${badge}`}>{DRILL_ISSUE_STATUS_LABELS[issue.status]}</span>
        </div>
        <div className="hint">
          位置：{issueTargetText(issue, allFloors)} · 发现于 {issue.foundAt}
          {issue.resolvedDrillId && <> · 于 <Link to={`/drill/${issue.resolvedDrillId}`}>{issue.resolvedAt}</Link> 复查{issue.status === 'resolved' ? '确认改进' : '关闭'}</>}
          {issue.followUpNote && <> · 复查备注：{issue.followUpNote}</>}
        </div>
        {mode === 'note' ? (
          <div className="row" style={{ marginTop: 4 }}>
            <input style={{ flex: 1 }} placeholder="复查备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
            <button onClick={() => { resolveDrillIssue(issue.id, 'resolved', currentDrillId, drillDate, note || undefined); setMode('view'); }}>
              确认已改进
            </button>
            <button onClick={() => { resolveDrillIssue(issue.id, 'still_open', currentDrillId, drillDate, note || undefined); setMode('view'); }}>
              仍存在
            </button>
            <button className="ghost" onClick={() => setMode('view')}>取消</button>
          </div>
        ) : (
          issue.status === 'open' && (
            <div style={{ marginTop: 4 }}>
              <button onClick={() => setMode('note')}>本次复查</button>{' '}
              <button
                className="ghost"
                onClick={() => {
                  if (confirm('标记为「不处理」？可在问题列表重新打开')) {
                    resolveDrillIssue(issue.id, 'wontfix', currentDrillId, drillDate);
                  }
                }}
              >
                不处理
              </button>{' '}
              <button className="danger ghost" onClick={() => confirm('删除该问题记录？') && removeDrillIssue(issue.drillId, issue.id)}>删除</button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ---------- 主页面 ----------

export function DrillEditorPage({ drillId }: { drillId: string }) {
  const drill = useStore((s) => s.drills.find((d) => d.id === drillId));
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const allDrills = useStore((s) => s.drills);

  const followUps = useMemo(() => (drill ? followUpsForDrill(allDrills, drill) : []), [allDrills, drill]);
  // 之前挂账、在本次演练里给出复查结论的历史问题（结论回写在原问题上）
  const reviewedHere = useMemo(
    () =>
      drill
        ? allDrills.flatMap((d) => d.issues).filter((i) => i.resolvedDrillId === drill.id && i.drillId !== drill.id)
        : [],
    [allDrills, drill],
  );
  const warnings = useMemo(() => (drill ? drillWarnings(drill) : []), [drill]);

  if (!drill) return <div className="page">演练记录不存在。<Link to="/drills">返回演练列表</Link></div>;

  const building = buildings.find((b) => b.id === drill.buildingId);
  const recs = drill.floors;
  const timingByFloor = drillFloorTimings(drill);
  // 与渲染使用同一份 segment 对象，最慢段可用 === 高亮
  let slowest: { floorId: string; segment: FloorTiming['segments'][number] } | null = null;
  for (const [floorId, tm] of timingByFloor) {
    for (const seg of tm.segments) {
      if (seg.anomalous) continue;
      if (!slowest || seg.durationMs > slowest.segment.durationMs) slowest = { floorId, segment: seg };
    }
  }
  const order = floorFinishOrder(drill);
  const rankedCount = order.length;
  const rankOf = (fid: string) => (order.includes(fid) ? order.indexOf(fid) + 1 : null);

  const fireFloor = drill.fireOrigin.floorId ? floors[drill.fireOrigin.floorId] : undefined;
  const fireRooms = fireFloor?.rooms ?? [];

  const setBase = (patch: Parameters<typeof updateDrill>[1]) => updateDrill(drill.id, patch);
  const floorOptions = (building?.floors ?? []).map((fid) => floors[fid]).filter(Boolean);

  const allFloorsSimple: Record<string, FloorLite> = {};
  for (const f of Object.values(floors)) allFloorsSimple[f.id] = f;

  // 本演练自己登记的问题
  const ownIssues = drill.issues;

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="crumb">
        <Link to="/drills">疏散演练</Link> / <Link to={`/drills/${drill.buildingId}`}>{building?.name ?? '建筑'}</Link> / 演练录入
      </div>

      {/* ---------- 基本信息 ---------- */}
      <h2>
        <input
          type="date"
          value={drill.date}
          onChange={(e) => {
            const date = e.target.value;
            // 改日期时保留时分（startedAt 形如 2026-09-20T09:00[:00]）
            const hhmm = /T(\d{2}:\d{2}(?::\d{2})?)$/.exec(drill.startedAt)?.[1] ?? '09:00';
            setBase({ date, startedAt: `${date}T${hhmm}` });
          }}
          style={{ fontWeight: 700 }}
        />
        <input
          placeholder="演练名称，如：三季度全员演练"
          value={drill.name ?? ''}
          onChange={(e) => setBase({ name: e.target.value })}
          style={{ marginLeft: 8, width: 260 }}
        />
      </h2>
      <div className="toolbar">
        <label className="row">统一计时起点 <TimeInput value={drill.startedAt} onChange={(v) => setBase({ startedAt: v })} /></label>
        <label className="row">
          参演总人数
          <NumInput style={{ width: 90 }} value={drill.participants} onChange={(v) => setBase({ participants: v })} />
        </label>
      </div>
      <div className="toolbar">
        <label className="row">
          假设起火点
          <select
            value={drill.fireOrigin.floorId ?? ''}
            onChange={(e) => setBase({ fireOrigin: { ...drill.fireOrigin, floorId: e.target.value || undefined, roomId: undefined } })}
          >
            <option value="">选择楼层…</option>
            {floorOptions.map((f) => <option key={f.id} value={f.id}>{floorLabel(f.level)}</option>)}
          </select>
          <select
            value={drill.fireOrigin.roomId ?? ''}
            disabled={!fireFloor}
            onChange={(e) => setBase({ fireOrigin: { ...drill.fireOrigin, roomId: e.target.value || undefined } })}
          >
            <option value="">选择房间（可不选）…</option>
            {fireRooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input
            placeholder="补充位置，如：配电井旁"
            value={drill.fireOrigin.detail ?? ''}
            onChange={(e) => setBase({ fireOrigin: { ...drill.fireOrigin, detail: e.target.value } })}
            style={{ width: 200 }}
          />
        </label>
      </div>
      <div className="toolbar">
        <input
          placeholder="场景说明（可选），如：工作日午后、3F 电器起火"
          value={drill.scenario ?? ''}
          onChange={(e) => setBase({ scenario: e.target.value })}
          style={{ flex: 1, minWidth: 300 }}
        />
      </div>

      {/* 录入自检 */}
      {warnings.length > 0 && (
        <div className="section validation" style={{ padding: 10 }}>
          {warnings.map((w, i) => (
            <div key={i} className="item" style={{ border: 'none', padding: '2px 0' }}>
              <span className={`dot ${w.level === 'error' ? 'error' : 'warning'}`} />
              <span className={w.level === 'error' ? 'bad' : 'warn'}>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---------- 上次遗留问题复查 ---------- */}
      {followUps.length > 0 && (
        <div className="section">
          <h4 style={{ margin: '0 0 8px' }}>本次重点复查（上次演练挂账的待改进问题，共 {followUps.length} 项）</h4>
          <p className="hint">下次演练专门看它有没有改进——逐项确认「已改进 / 仍存在」，结论会回写到原问题上。</p>
          <div className="items">
            {followUps.map((i) => (
              <IssueRow key={i.id} issue={i} drillDate={drill.date} allFloors={allFloorsSimple} currentDrillId={drill.id} />
            ))}
          </div>
        </div>
      )}

      {/* ---------- 按楼层记录 ---------- */}
      <h2 style={{ marginTop: 18 }}>按楼层记录</h2>
      {recs.length === 0 && <p className="hint">该建筑还没有楼层。<Link to={`/building/${drill.buildingId}`}>先去建楼层</Link></p>}

      {recs.map((rec) => {
        const f = floors[rec.floorId];
        const timing = timingByFloor.get(rec.floorId)!;
        const rank = rankOf(rec.floorId);
        const isSlowFloor = slowest?.floorId === rec.floorId;
        return (
          <div className="section" key={rec.floorId}>
            <div className="toolbar" style={{ margin: 0 }}>
              <b style={{ minWidth: 40 }}>{f ? floorLabel(f.level) : '（楼层已删除）'}</b>
              <label className="row">
                疏散指挥
                <input
                  style={{ width: 120 }}
                  placeholder="姓名"
                  value={rec.commander}
                  onChange={(e) => setDrillFloorRecord(drill.id, rec.floorId, { commander: e.target.value })}
                />
              </label>
              <label className="row">
                本层人数
                <NumInput
                  style={{ width: 80 }}
                  placeholder="可空"
                  value={rec.participants}
                  onChange={(v) => setDrillFloorRecord(drill.id, rec.floorId, { participants: v })}
                />
              </label>
              <span className="hint">
                用时 <b>{fmtDuration(timing.totalMs)}</b>
                {rank != null && <> · 撤离第 {rank}/{rankedCount} 名{rank === rankedCount && rankedCount > 1 ? '（最后）' : ''}</>}
                {timing.anomalies > 0 && <span className="bad"> · {timing.anomalies} 处时间倒挂</span>}
              </span>
            </div>

            <table className="table" style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <td style={{ width: 90 }} className="hint">开始时间</td>
                  <td><TimeInput label="开始时间" value={rec.startedAt} onChange={(v) => setDrillFloorRecord(drill.id, rec.floorId, { startedAt: v })} /></td>
                  <td style={{ width: 90 }} className="hint">结束时间</td>
                  <td><TimeInput label="结束时间" value={rec.completedAt} onChange={(v) => setDrillFloorRecord(drill.id, rec.floorId, { completedAt: v })} /></td>
                </tr>
                <tr>
                  <td className="hint">楼道口拥堵</td>
                  <td colSpan={3}>
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={rec.blocked}
                        onChange={(e) => setDrillFloorRecord(drill.id, rec.floorId, { blocked: e.target.checked })}
                      />
                      有人员堵在楼道口
                      <input
                        placeholder="堵在哪里/什么情况"
                        value={rec.blockedNote ?? ''}
                        disabled={!rec.blocked}
                        onChange={(e) => setDrillFloorRecord(drill.id, rec.floorId, { blockedNote: e.target.value })}
                        style={{ flex: 1 }}
                      />
                    </label>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* 关键节点通过时间 */}
            <div className="toolbar" style={{ marginTop: 8 }}>
              <b>路线关键节点（楼梯口、出口）</b>
              <button onClick={() => addDrillNode(drill.id, rec.floorId, 'stair')}>＋楼梯口</button>
              <button onClick={() => addDrillNode(drill.id, rec.floorId, 'exit')}>＋出口</button>
            </div>
            {rec.nodes.length > 0 && (
              <table className="table">
                <thead>
                  <tr><th style={{ width: 30 }}>#</th><th style={{ width: 90 }}>类型</th><th>节点</th><th>通过时间</th><th style={{ width: 130 }}>排序/删除</th></tr>
                </thead>
                <tbody>
                  {rec.nodes.map((n, i) => (
                    <NodeRow key={n.id} drillId={drill.id} floorId={rec.floorId} node={n} index={i} total={rec.nodes.length} />
                  ))}
                </tbody>
              </table>
            )}

            {/* 段用时分解 */}
            {timing.segments.length > 0 && (
              <div className="segment-row">
                {timing.segments.map((seg, i) => {
                  const isGlobalSlow = slowest?.floorId === rec.floorId && slowest.segment === seg;
                  return (
                    <span
                      key={i}
                      className={`seg ${seg.anomalous ? 'seg-bad' : ''} ${isGlobalSlow ? 'seg-slow' : ''}`}
                      title={`${seg.fromLabel} → ${seg.toLabel}${seg.crossFloor ? '（楼梯段）' : ''}`}
                    >
                      <span className="seg-name">{seg.fromLabel} → {seg.toLabel}{seg.crossFloor ? ' 🪜' : ''}</span>
                      <b>{fmtDuration(seg.durationMs)}</b>
                    </span>
                  );
                })}
              </div>
            )}
            {isSlowFloor && slowest && (
              <p className="hint" style={{ marginBottom: 0 }}>
                ★ 全程最慢段在本层：{slowest.segment.fromLabel} → {slowest.segment.toLabel}，
                用时 <b className="bad">{fmtDuration(slowest.segment.durationMs)}</b>
                {slowest.segment.crossFloor ? '（层间楼梯段）' : ''}
              </p>
            )}

            <div className="row" style={{ marginTop: 6 }}>
              <input
                placeholder="本层备注（可选）"
                value={rec.note ?? ''}
                onChange={(e) => setDrillFloorRecord(drill.id, rec.floorId, { note: e.target.value })}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        );
      })}

      {/* ---------- 问题 ---------- */}
      <h2 style={{ marginTop: 18 }}>本次发现的问题</h2>
      <div className="section">
        <IssueForm drillId={drill.id} buildingFloorIds={(building?.floors ?? []).filter((fid) => floors[fid])} date={drill.date} />
        <div className="items" style={{ marginTop: 10 }}>
          {ownIssues.length === 0 && <span className="hint">本次未登记问题。演练中发现的问题请挂到具体房间或设施，下次演练自动带出复查。</span>}
          {ownIssues.map((i) => (
            <IssueRow key={i.id} issue={i} drillDate={drill.date} allFloors={allFloorsSimple} currentDrillId={drill.id} />
          ))}
        </div>
      </div>

      {/* 本次复查过的历史问题（结论回写在原问题上，只影响原演练的问题列表） */}
      {reviewedHere.length > 0 && (
        <details className="section">
          <summary className="hint">本次复查的历史问题结论（{reviewedHere.length}）</summary>
          <div className="items" style={{ marginTop: 8 }}>
            {reviewedHere.map((i) => (
              <IssueRow key={i.id} issue={i} drillDate={drill.date} allFloors={allFloorsSimple} currentDrillId={drill.id} />
            ))}
          </div>
        </details>
      )}

      <div className="toolbar">
        <Link className="btn" to={`/drills/${drill.buildingId}`}>完成，返回列表</Link>
        <Link to={`/building/${drill.buildingId}`}>查看建筑楼层</Link>
      </div>
    </div>
  );
}
