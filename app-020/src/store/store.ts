import { useSyncExternalStore } from 'react';
import type {
  Building,
  BuildingKind,
  CheckRecord,
  Drill,
  DrillFloorRecord,
  DrillIssue,
  DrillNode,
  Facility,
  FacilityKind,
  Floor,
  IssueTarget,
  NodePass,
  Pt,
  Room,
  RoomUsage,
  RuleSet,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { floorLabel, nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';

const STORAGE_KEY = 'fem.v1';

export type AppState = {
  buildings: Building[];
  floors: Record<string, Floor>;
  rules: Record<BuildingKind, RuleSet>;
  /** 「您在此」标记（打印版疏散图），按楼层存 */
  marks: Record<string, Pt>;
  /** 疏散演练记录（按建筑） */
  drills: Drill[];
  /** 演练发现并挂到房间/设施的问题，跨演练跟踪整改 */
  issues: DrillIssue[];
};

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      // 缺失的节用默认值补齐（如旧版本数据没有 rules/marks/drills），而不是整体丢弃用户数据
      if (s && Array.isArray(s.buildings) && s.floors) {
        return {
          buildings: s.buildings,
          floors: s.floors,
          rules: { ...structuredClone(DEFAULT_RULES), ...(s.rules ?? {}) },
          marks: s.marks ?? {},
          drills: s.drills ?? [],
          issues: s.issues ?? [],
        };
      }
    }
  } catch {
    /* 损坏则重新开始 */
  }
  return { buildings: [], floors: {}, rules: structuredClone(DEFAULT_RULES), marks: {}, drills: [], issues: [] };
}

let state: AppState = loadState();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储满时忽略（照片/底图在 IndexedDB，不受影响） */
    }
  }, 200);
}

function setState(patch: (s: AppState) => void) {
  patch(state);
  // 浅拷贝各容器：保证 s.buildings / s.floors / s.rules / s.marks 选择器拿到新引用
  state = {
    buildings: [...state.buildings],
    floors: { ...state.floors },
    rules: { ...state.rules },
    marks: { ...state.marks },
    drills: [...state.drills],
    issues: [...state.issues],
  };
  persist();
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState(): AppState {
  return state;
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** 修改楼层并替换其引用 —— 保证 useStore(s => s.floors[id]) 的订阅者能感知更新 */
function updateFloor(floorId: string, mut: (f: Floor) => void) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    mut(f);
    s.floors[floorId] = { ...f };
  });
}

// ---------- 建筑 ----------

export function addBuilding(name: string, kind: BuildingKind): string {
  const id = uid();
  const b: Building = { id, name, kind, floors: [], createdAt: new Date().toISOString() };
  setState((s) => s.buildings.push(b));
  return id;
}

export function updateBuilding(id: string, patch: Partial<Pick<Building, 'name' | 'kind'>>) {
  setState((s) => {
    const i = s.buildings.findIndex((x) => x.id === id);
    if (i >= 0) s.buildings[i] = { ...s.buildings[i], ...patch };
  });
}

export function deleteBuilding(id: string) {
  setState((s) => {
    const b = s.buildings.find((x) => x.id === id);
    if (!b) return;
    for (const fid of b.floors) delete s.floors[fid];
    s.buildings = s.buildings.filter((x) => x.id !== id);
    s.drills = s.drills.filter((d) => d.buildingId !== id);
    s.issues = s.issues.filter((i) => i.buildingId !== id);
  });
}

// ---------- 楼层 ----------

export function addFloor(buildingId: string, level: number): string {
  const id = uid();
  const floor: Floor = {
    id,
    buildingId,
    level,
    scaleMmPerUnit: 1,
    rooms: [],
    facilities: [],
    exits: [],
    version: 0,
  };
  setState((s) => {
    s.floors[id] = floor;
    const bi = s.buildings.findIndex((x) => x.id === buildingId);
    if (bi >= 0) s.buildings[bi] = { ...s.buildings[bi], floors: [...s.buildings[bi].floors, id] };
  });
  return id;
}

export function deleteFloor(floorId: string) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    const bi = s.buildings.findIndex((x) => x.id === f.buildingId);
    if (bi >= 0) {
      s.buildings[bi] = { ...s.buildings[bi], floors: s.buildings[bi].floors.filter((x) => x !== floorId) };
    }
    delete s.floors[floorId];
    delete s.marks[floorId];
  });
}

// ---------- 房间 ----------

export function addRoom(floorId: string, polygon: Pt[], name: string, usage: RoomUsage): string {
  const id = uid();
  updateFloor(floorId, (f) => {
    f.version++;
    f.rooms.push({ id, polygon, name, usage, areaM2: polyAreaM2(polygon) });
  });
  return id;
}

export function updateRoom(floorId: string, roomId: string, patch: Partial<Pick<Room, 'name' | 'usage' | 'occupants'>>) {
  updateFloor(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (r) {
      Object.assign(r, patch);
      f.version++;
    }
  });
}

export function deleteRoom(floorId: string, roomId: string) {
  updateFloor(floorId, (f) => {
    f.version++;
    f.rooms = f.rooms.filter((x) => x.id !== roomId);
  });
}

/** 拖动整体平移房间多边形（保留 id、人数等属性与数组顺序） */
export function moveRoom(floorId: string, roomId: string, dx: number, dy: number) {
  updateFloor(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (!r) return;
    r.polygon = r.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    f.version++;
  });
}

// ---------- 设施 ----------

export function addFacility(floorId: string, kind: FacilityKind, x: number, y: number): string {
  const id = uid();
  updateFloor(floorId, (f) => {
    const fac: Facility = { id, kind, x, y, code: nextCode(f, kind), checks: [] };
    if (kind === 'extinguisher') fac.spec = { extType: 'dry_powder', weightKg: 4 };
    f.version++;
    f.facilities.push(fac);
    if (kind === 'exit') f.exits.push(id);
  });
  return id;
}

export function moveFacility(floorId: string, facilityId: string, x: number, y: number) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x2) => x2.id === facilityId);
    if (fac) {
      fac.x = x;
      fac.y = y;
      f.version++;
    }
  });
}

export function updateFacility(floorId: string, facilityId: string, patch: Partial<Pick<Facility, 'spec'>>) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac && patch.spec) {
      fac.spec = patch.spec;
      f.version++;
    }
  });
}

export function deleteFacility(floorId: string, facilityId: string) {
  updateFloor(floorId, (f) => {
    f.version++;
    f.facilities = f.facilities.filter((x) => x.id !== facilityId);
    f.exits = f.exits.filter((x) => x !== facilityId);
  });
}

export function addCheck(floorId: string, facilityId: string, check: CheckRecord) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.push(check);
      f.version++;
    }
  });
}

export function deleteCheck(floorId: string, facilityId: string, index: number) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.splice(index, 1);
      f.version++;
    }
  });
}

// ---------- 底图 / 标记 / 校验结果 ----------

export function setUnderlay(floorId: string, underlay: Floor['underlay']) {
  updateFloor(floorId, (f) => {
    f.underlay = underlay;
  });
}

export function setMark(floorId: string, pt: Pt) {
  setState((s) => {
    s.marks[floorId] = { ...pt };
  });
}

export function setLastValidation(floorId: string, result: ValidationResult) {
  updateFloor(floorId, (f) => {
    f.lastValidation = result;
  });
}

// ---------- 规则 ----------

export function updateRules(kind: BuildingKind, patch: Partial<Omit<RuleSet, 'buildingKind' | 'version'>>) {
  setState((s) => {
    const r = s.rules[kind];
    s.rules[kind] = { ...r, ...patch, version: r.version + 1 };
  });
}

export function resetRules(kind: BuildingKind) {
  setState((s) => {
    s.rules[kind] = structuredClone(DEFAULT_RULES[kind]);
  });
  persist();
}

// ---------- 疏散演练 ----------

/** 从楼层的安全出口设施预填路线节点 */
function exitNodesOf(floors: Floor[], floorIds: string[]): DrillNode[] {
  // 楼层按从高到低：高楼层人员经楼梯口逐层向下，出口节点在首层
  const byId = new Map(floors.map((f) => [f.id, f]));
  const ordered = floorIds
    .map((id) => byId.get(id))
    .filter((f): f is Floor => !!f)
    .sort((a, b) => b.level - a.level);
  const nodes: DrillNode[] = [];
  ordered.forEach((f, fi) => {
    const exits = f.facilities.filter((x) => x.kind === 'exit');
    exits.forEach((e) => {
      nodes.push({
        id: uid(),
        kind: 'exit',
        name: e.code ? `${e.code} 出口` : `${floorLabel(f.level)} 出口`,
        floorId: f.id,
        facilityId: e.id,
      });
    });
    // 无显式出口设施时，仍给一个本层楼梯口占位，方便现场补时间
    if (exits.length === 0 && fi < ordered.length - 1) {
      nodes.push({ id: uid(), kind: 'stair', name: `${floorLabel(f.level)} 楼梯口`, floorId: f.id });
    }
  });
  return nodes;
}

/** 新建演练：按该建筑现有楼层预填各层记录与出口节点 */
export function addDrill(buildingId: string, init?: Partial<Pick<Drill, 'date' | 'alarmAt' | 'participants' | 'note'>>): string {
  const id = uid();
  setState((s) => {
    const b = s.buildings.find((x) => x.id === buildingId);
    if (!b) return;
    const floorIds = [...b.floors].sort((x, y) => (s.floors[y]?.level ?? 0) - (s.floors[x]?.level ?? 0));
    const floors: DrillFloorRecord[] = floorIds.map((floorId) => ({ floorId, commander: '', blocked: false }));
    s.drills.push({
      id,
      buildingId,
      date: init?.date ?? new Date().toISOString().slice(0, 10),
      alarmAt: init?.alarmAt ?? '09:00',
      participants: init?.participants ?? 0,
      note: init?.note,
      nodes: exitNodesOf(b.floors.map((fid) => s.floors[fid]).filter(Boolean), b.floors),
      floors,
      passes: [],
      createdAt: new Date().toISOString(),
    });
  });
  return id;
}

function updateDrill(drillId: string, mut: (d: Drill) => void) {
  setState((s) => {
    const i = s.drills.findIndex((x) => x.id === drillId);
    if (i < 0) return;
    mut(s.drills[i]);
    s.drills[i] = { ...s.drills[i] };
  });
}

export function patchDrill(drillId: string, patch: Partial<Omit<Drill, 'id'>>) {
  updateDrill(drillId, (d) => Object.assign(d, patch));
}

export function deleteDrill(drillId: string) {
  setState((s) => {
    s.drills = s.drills.filter((x) => x.id !== drillId);
    // 历史问题保留；仅去掉挂在这次演练上的复查记录
    for (const iss of s.issues) {
      if (iss.followUps.some((f) => f.drillId === drillId)) {
        iss.followUps = iss.followUps.filter((f) => f.drillId !== drillId);
      }
      if (iss.drillId === drillId) iss.drillId = undefined;
    }
  });
}

// —— 各层记录 ——

export function patchFloorRecord(drillId: string, floorId: string, patch: Partial<Omit<DrillFloorRecord, 'floorId'>>) {
  updateDrill(drillId, (d) => {
    let rec = d.floors.find((r) => r.floorId === floorId);
    if (!rec) {
      rec = { floorId, commander: '', blocked: false };
      d.floors.push(rec);
    }
    Object.assign(rec, patch);
  });
}

// —— 路线节点与通过时间 ——

export function addDrillNode(drillId: string, node: Omit<DrillNode, 'id'>, afterIndex?: number): string {
  const id = uid();
  updateDrill(drillId, (d) => {
    const n: DrillNode = { ...node, id };
    if (afterIndex == null || afterIndex < 0 || afterIndex >= d.nodes.length) d.nodes.push(n);
    else d.nodes.splice(afterIndex + 1, 0, n);
  });
  return id;
}

export function patchDrillNode(drillId: string, nodeId: string, patch: Partial<Omit<DrillNode, 'id'>>) {
  updateDrill(drillId, (d) => {
    const n = d.nodes.find((x) => x.id === nodeId);
    if (n) Object.assign(n, patch);
  });
}

export function removeDrillNode(drillId: string, nodeId: string) {
  updateDrill(drillId, (d) => {
    d.nodes = d.nodes.filter((x) => x.id !== nodeId);
    d.passes = d.passes.filter((p) => p.nodeId !== nodeId);
  });
}

/** 移动节点在路线中的顺序（dir：-1 前移 / +1 后移） */
export function moveDrillNode(drillId: string, nodeId: string, dir: -1 | 1) {
  updateDrill(drillId, (d) => {
    const i = d.nodes.findIndex((x) => x.id === nodeId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.nodes.length) return;
    [d.nodes[i], d.nodes[j]] = [d.nodes[j], d.nodes[i]];
  });
}

export function setNodePass(drillId: string, nodeId: string, at?: string) {
  updateDrill(drillId, (d) => {
    let p = d.passes.find((x) => x.nodeId === nodeId);
    if (!p) {
      p = { nodeId } as NodePass;
      d.passes.push(p);
    }
    p.at = at || undefined;
  });
}

// ---------- 演练问题（整改跟踪） ----------

export function addIssue(buildingId: string, drillId: string | undefined, target: IssueTarget, description: string): string {
  const id = uid();
  setState((s) => {
    s.issues.push({
      id,
      buildingId,
      drillId,
      target,
      description,
      status: 'open',
      createdAt: new Date().toISOString(),
      followUps: [],
    });
  });
  return id;
}

export function setIssueStatus(issueId: string, status: DrillIssue['status']) {
  setState((s) => {
    const i = s.issues.find((x) => x.id === issueId);
    if (i) i.status = status;
  });
}

/** 在某次演练中复查老问题 */
export function addFollowUp(issueId: string, drillId: string, result: DrillIssue['followUps'][number]['result'], note?: string) {
  setState((s) => {
    const i = s.issues.find((x) => x.id === issueId);
    if (!i) return;
    i.followUps = i.followUps.filter((f) => f.drillId !== drillId);
    i.followUps.push({ drillId, result, note, at: new Date().toISOString() });
    if (result === 'fixed') i.status = 'fixed';
    else if (i.status === 'fixed') i.status = 'open'; // 复查发现回潮，重新打开
  });
}

export function deleteIssue(issueId: string) {
  setState((s) => {
    s.issues = s.issues.filter((x) => x.id !== issueId);
  });
}

// ---------- 示例数据 ----------

const M = 1000;
function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x: x * M, y: y * M },
    { x: (x + w) * M, y: y * M },
    { x: (x + w) * M, y: (y + h) * M },
    { x: x * M, y: (y + h) * M },
  ];
}

/** 载入示例：41m 走道双出口 + 10 个房间，办公楼规则全过；切换厂房规则后灭火器覆盖不合规 */
export function loadDemo(): string {
  let bid = '';
  setState((s) => {
    const buildingId = uid();
    bid = buildingId;
    const floorId = uid();
    const f2 = uid();
    const f3 = uid();
    s.buildings.push({
      id: buildingId,
      name: '示例办公楼',
      kind: 'office',
      floors: [floorId, f2, f3],
      createdAt: new Date().toISOString(),
    });
    const rooms: Room[] = [];
    const mk = (name: string, usage: RoomUsage, poly: Pt[], occupants?: number) => {
      rooms.push({ id: uid(), polygon: poly, name, usage, areaM2: polyAreaM2(poly), occupants });
    };
    mk('走道', 'corridor', rect(0, 0, 41, 2));
    const names = ['101', '102', '103', '104', '105'];
    for (let i = 0; i < 5; i++) {
      mk(`${names[i]}室`, i === 2 ? 'storage' : 'office', rect(i * 8, 2, 8, 6), i === 2 ? 2 : 10);
      mk(`${names[i]}B室`, i === 0 ? 'retail' : 'office', rect(i * 8, -5, 8, 5), i === 0 ? 15 : 10);
    }
    const facilities: Facility[] = [];
    const dateStr = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const mkF = (kind: FacilityKind, x: number, y: number, code: string, checks: Facility['checks'] = [], spec?: Facility['spec']) => {
      facilities.push({ id: uid(), kind, x: x * M, y: y * M, code, checks, spec });
    };
    mkF('exit', 0.5, 1, '1F-EXIT-01');
    mkF('exit', 40.5, 1, '1F-EXIT-02');
    mkF('extinguisher', 20.5, 1, '1F-EX-01', [{ date: dateStr(20), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 4, 5, '1F-EX-02', [{ date: dateStr(45), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 36, 5, '1F-EX-03', [], { extType: 'co2', weightKg: 2 });
    mkF('hydrant', 10, 1, '1F-HY-01', [{ date: dateStr(10), status: 'ok' }]);
    mkF('exit_sign', 1, 1.7, '1F-ES-01', [{ date: dateStr(15), status: 'ok' }]);
    mkF('exit_sign', 40, 1.7, '1F-ES-02', [{ date: dateStr(15), status: 'ok' }]);
    mkF('emergency_light', 20.5, 0.4, '1F-EL-01', [{ date: dateStr(15), status: 'ok' }]);
    const exits = facilities.filter((f) => f.kind === 'exit').map((f) => f.id);
    s.floors[floorId] = {
      id: floorId,
      buildingId,
      level: 1,
      scaleMmPerUnit: 1,
      rooms,
      facilities,
      exits,
      version: 0,
    };

    // 2F / 3F：同样的走道 + 房间，各两个安全出口（共享东西两座楼梯）
    const upper = (level: number, fid: string): Floor => {
      const rs: Room[] = [
        { id: uid(), polygon: rect(0, 0, 41, 2), name: '走道', usage: 'corridor', areaM2: 82 },
        { id: uid(), polygon: rect(2, 2, 8, 6), name: `${level}01室`, usage: 'office', areaM2: 48, occupants: 12 },
        { id: uid(), polygon: rect(16, 2, 8, 6), name: `${level}02室`, usage: 'office', areaM2: 48, occupants: 10 },
      ];
      const fs: Facility[] = [
        { id: uid(), kind: 'exit', x: 0.5 * M, y: 1 * M, code: `${level}F-EXIT-01`, checks: [] },
        { id: uid(), kind: 'exit', x: 40.5 * M, y: 1 * M, code: `${level}F-EXIT-02`, checks: [] },
      ];
      return {
        id: fid,
        buildingId,
        level,
        scaleMmPerUnit: 1,
        rooms: rs,
        facilities: fs,
        exits: fs.map((x) => x.id),
        version: 0,
      };
    };
    const floor2 = upper(2, f2);
    const floor3 = upper(3, f3);
    s.floors[f2] = floor2;
    s.floors[f3] = floor3;

    const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const fl1Exit = (i: number) => s.floors[floorId].facilities.filter((x) => x.kind === 'exit')[i].id;
    const fl2Exit = (i: number) => floor2.facilities.filter((x) => x.kind === 'exit')[i].id;
    const fl3Exit = (i: number) => floor3.facilities.filter((x) => x.kind === 'exit')[i].id;
    const stairNode = (kind: DrillNode['kind'], name: string, fl: Floor, facilityId?: string): DrillNode => ({
      id: uid(), kind, name, floorId: fl.id, facilityId,
    });

    // 第一次演练（40 天前）：3F 在东楼梯口堵口，全员走西出口，3F 最后撤完
    const nodesA = [
      stairNode('stair', '3F 东楼梯口', floor3),
      stairNode('stair', '3F 西楼梯口', floor3),
      stairNode('stair', '2F 西楼梯口', floor2),
      stairNode('exit', '1F-EXIT-01 西出口', s.floors[floorId], fl1Exit(0)),
    ];
    const dA: Drill = {
      id: uid(),
      buildingId,
      date: day(40),
      alarmAt: '09:00',
      fireFloorId: floorId,
      fireRoomId: rooms.find((r) => r.name === '103室')?.id,
      fireNote: '配电箱旁废纸起火（假设）',
      participants: 86,
      nodes: nodesA,
      floors: [
        { floorId: f3, commander: '王强', start: '09:00', end: '09:04:10', blocked: true, note: '东楼梯口堆物，人流折返改走西侧' },
        { floorId: f2, commander: '李敏', start: '09:00', end: '09:03:05', blocked: false },
        { floorId, commander: '赵磊', start: '09:00', end: '09:02:40', blocked: false },
      ],
      passes: [
        { nodeId: nodesA[0].id, at: '09:01:30' },
        { nodeId: nodesA[1].id, at: '09:02:20' },
        { nodeId: nodesA[2].id, at: '09:03:00' },
        { nodeId: nodesA[3].id, at: '09:03:55' },
      ],
      note: '东楼梯口通道被杂物占用，导致 3F 分流失败',
      createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    };

    // 第二次演练（5 天前）：清理堆物后东西分流，3F 仍最慢但堵口消除
    const nodesB = [
      stairNode('stair', '3F 东楼梯口', floor3),
      stairNode('stair', '3F 西楼梯口', floor3),
      stairNode('stair', '2F 东楼梯口', floor2),
      stairNode('stair', '2F 西楼梯口', floor2),
      stairNode('exit', '1F-EXIT-01 西出口', s.floors[floorId], fl1Exit(0)),
      stairNode('exit', '1F-EXIT-02 东出口', s.floors[floorId], fl1Exit(1)),
    ];
    // 引用一次，避免未使用告警（节点以楼层出口为锚点）
    void fl2Exit; void fl3Exit;
    const dB: Drill = {
      id: uid(),
      buildingId,
      date: day(5),
      alarmAt: '10:00',
      fireFloorId: f2,
      fireRoomId: floor2.rooms.find((r) => r.name === '202室')?.id,
      fireNote: '茶水间电器过热冒烟（假设）',
      participants: 92,
      nodes: nodesB,
      floors: [
        { floorId: f3, commander: '王强', start: '10:00', end: '10:03:20', blocked: false },
        { floorId: f2, commander: '李敏', start: '10:00', end: '10:03:00', blocked: false },
        { floorId, commander: '赵磊', start: '10:00', end: '10:02:25', blocked: false },
      ],
      passes: [
        { nodeId: nodesB[0].id, at: '10:01:10' },
        { nodeId: nodesB[1].id, at: '10:01:20' },
        { nodeId: nodesB[2].id, at: '10:02:00' },
        { nodeId: nodesB[3].id, at: '10:02:05' },
        { nodeId: nodesB[4].id, at: '10:02:40' },
        { nodeId: nodesB[5].id, at: '10:02:50' },
      ],
      note: '东楼梯口堆物已清理，东西两座楼梯同时分流',
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    };
    s.drills.push(dA, dB);

    const issue: DrillIssue = {
      id: uid(),
      buildingId,
      drillId: dA.id,
      target: { kind: 'room', floorId: f3, roomId: floor3.rooms.find((r) => r.name === '302室')!.id },
      description: '3F 东楼梯口前堆放纸箱杂物，疏散分流时造成堵口',
      status: 'fixed',
      createdAt: dA.createdAt,
      followUps: [
        { drillId: dB.id, result: 'fixed', note: '堆物已清理，现场无堵口', at: dB.createdAt },
      ],
    };
    const issue2: DrillIssue = {
      id: uid(),
      buildingId,
      drillId: dB.id,
      target: { kind: 'facility', floorId: f2, facilityId: floor2.facilities[0].id },
      description: '2F 西楼梯口应急照明亮度不足，夜间演练辨识度差',
      status: 'open',
      createdAt: dB.createdAt,
      followUps: [],
    };
    s.issues.push(issue, issue2);
  });
  persist();
  return bid;
}
