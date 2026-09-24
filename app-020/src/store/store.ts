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
  FireOrigin,
  Floor,
  Pt,
  Room,
  RoomUsage,
  RuleSet,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';

const STORAGE_KEY = 'fem.v1';

export type AppState = {
  buildings: Building[];
  floors: Record<string, Floor>;
  rules: Record<BuildingKind, RuleSet>;
  /** 「您在此」标记（打印版疏散图），按楼层存 */
  marks: Record<string, Pt>;
  /** 疏散演练记录（按建筑挂接） */
  drills: Drill[];
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
        };
      }
    }
  } catch {
    /* 损坏则重新开始 */
  }
  return { buildings: [], floors: {}, rules: structuredClone(DEFAULT_RULES), marks: {}, drills: [] };
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
  // 浅拷贝各容器：保证 s.buildings / s.floors / s.rules / s.marks / s.drills 选择器拿到新引用
  state = {
    buildings: [...state.buildings],
    floors: { ...state.floors },
    rules: { ...state.rules },
    marks: { ...state.marks },
    drills: [...state.drills],
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
    // 演练整份随建筑删除
    s.drills = s.drills.filter((d) => d.buildingId !== id);
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
    // 已有演练补一层空记录，不覆盖已录数据
    for (const d of s.drills) {
      if (d.buildingId === buildingId && !d.floors.some((r) => r.floorId === id)) {
        d.floors = [...d.floors, emptyFloorRecord(id)];
      }
    }
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
    // 演练记录里摘掉该层（保留演练本身与其他楼层数据；问题若只挂在该层也摘掉定位）
    s.drills = s.drills.map((d) => {
      const hasFloor = d.floors.some((r) => r.floorId === floorId);
      const hasIssue = d.issues.some((i) => i.floorId === floorId);
      if (!hasFloor && !hasIssue) return d;
      return {
        ...d,
        floors: d.floors.filter((r) => r.floorId !== floorId),
        issues: d.issues.map((i) =>
          i.floorId === floorId ? { ...i, floorId: undefined, roomId: undefined, facilityId: undefined } : i,
        ),
      };
    });
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

// ---------- 疏散演练 ----------

/** 空楼层记录：跟随建筑楼层初始化，指挥/时间留空待录 */
export function emptyFloorRecord(floorId: string): DrillFloorRecord {
  return { floorId, commander: '', participants: null, startedAt: '', completedAt: '', blocked: false, nodes: [] };
}

/** 新建演练：默认带出建筑全部楼层的空记录，便于逐层补录 */
export function addDrill(buildingId: string, date: string): string {
  const id = uid();
  const b = state.buildings.find((x) => x.id === buildingId);
  const floors = (b?.floors ?? []).map((fid) => emptyFloorRecord(fid));
  const drill: Drill = {
    id,
    buildingId,
    date,
    startedAt: date ? `${date}T09:00` : '',
    participants: null,
    fireOrigin: {},
    floors,
    issues: [],
    createdAt: new Date().toISOString(),
  };
  setState((s) => s.drills.push(drill));
  return id;
}

export function deleteDrill(drillId: string) {
  setState((s) => {
    s.drills = s.drills.filter((d) => d.id !== drillId);
  });
}

/** 演练头字段（日期/名称/场景/总人数/起始时刻） */
export function updateDrill(
  drillId: string,
  patch: Partial<Pick<Drill, 'date' | 'startedAt' | 'name' | 'scenario' | 'participants' | 'fireOrigin'>>,
) {
  mutateDrill(drillId, (d) => Object.assign(d, patch));
}

function mutateDrill(drillId: string, mut: (d: Drill) => void) {
  setState((s) => {
    const i = s.drills.findIndex((d) => d.id === drillId);
    if (i < 0) return;
    const next: Drill = structuredClone(s.drills[i]);
    mut(next);
    s.drills[i] = next;
  });
}

function mutateFloorRecord(drillId: string, floorId: string, mut: (r: DrillFloorRecord) => void) {
  mutateDrill(drillId, (d) => {
    const r = d.floors.find((x) => x.floorId === floorId);
    if (r) mut(r);
  });
}

export function setDrillFloorRecord(drillId: string, floorId: string, patch: Partial<DrillFloorRecord>) {
  mutateFloorRecord(drillId, floorId, (r) => Object.assign(r, patch));
}

/** 建筑新增楼层后，给已有演练补空记录（不覆盖已录数据） */
export function ensureDrillFloor(drillId: string, floorId: string) {
  mutateDrill(drillId, (d) => {
    if (!d.floors.some((r) => r.floorId === floorId)) d.floors.push(emptyFloorRecord(floorId));
  });
}

export function addDrillNode(drillId: string, floorId: string, kind: DrillNode['kind']): string {
  const nodeId = uid();
  mutateFloorRecord(drillId, floorId, (r) => {
    r.nodes.push({ id: nodeId, kind, label: kind === 'stair' ? '楼梯口' : '出口', time: '' });
  });
  return nodeId;
}

export function updateDrillNode(drillId: string, floorId: string, nodeId: string, patch: Partial<Omit<DrillNode, 'id'>>) {
  mutateFloorRecord(drillId, floorId, (r) => {
    const n = r.nodes.find((x) => x.id === nodeId);
    if (n) Object.assign(n, patch);
  });
}

export function removeDrillNode(drillId: string, floorId: string, nodeId: string) {
  mutateFloorRecord(drillId, floorId, (r) => {
    r.nodes = r.nodes.filter((x) => x.id !== nodeId);
  });
}

export function moveDrillNode(drillId: string, floorId: string, nodeId: string, dir: -1 | 1) {
  mutateFloorRecord(drillId, floorId, (r) => {
    const i = r.nodes.findIndex((x) => x.id === nodeId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= r.nodes.length) return;
    const [n] = r.nodes.splice(i, 1);
    r.nodes.splice(j, 0, n);
  });
}

// ---------- 演练问题 ----------

export function addDrillIssue(drillId: string, issue: Omit<DrillIssue, 'id' | 'drillId' | 'status'>): string {
  const id = uid();
  mutateDrill(drillId, (d) => {
    d.issues.push({ ...issue, id, drillId: d.id, status: 'open' });
  });
  return id;
}

export function updateDrillIssue(
  drillId: string,
  issueId: string,
  patch: Partial<Omit<DrillIssue, 'id' | 'drillId'>>,
) {
  mutateDrill(drillId, (d) => {
    const i = d.issues.find((x) => x.id === issueId);
    if (i) Object.assign(i, patch);
  });
}

export function removeDrillIssue(drillId: string, issueId: string) {
  mutateDrill(drillId, (d) => {
    d.issues = d.issues.filter((x) => x.id !== issueId);
  });
}

/**
 * 复查上次遗留问题：在本次演练中标记结果。
 * 不改原问题归属，只更新状态/解决于哪次演练；仍存在则保持 open 并在描述里可补注。
 */
export function resolveDrillIssue(
  issueId: string,
  result: 'resolved' | 'still_open' | 'wontfix',
  drillId: string,
  date: string,
  note?: string,
) {
  setState((s) => {
    for (let di = 0; di < s.drills.length; di++) {
      const i = s.drills[di].issues.find((x) => x.id === issueId);
      if (!i) continue;
      const nextDrill = structuredClone(s.drills[di]);
      const ni = nextDrill.issues.find((x) => x.id === issueId)!;
      if (result === 'still_open') {
        ni.status = 'open';
        if (note) ni.followUpNote = note;
      } else {
        ni.status = result;
        ni.resolvedDrillId = drillId;
        ni.resolvedAt = date;
        if (note) ni.followUpNote = note;
      }
      s.drills[di] = nextDrill;
      break;
    }
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
    s.buildings.push({
      id: buildingId,
      name: '示例办公楼',
      kind: 'office',
      floors: [floorId],
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
    const exits = facilities.filter((f) => f.kind === 'exit');
    s.floors[floorId] = {
      id: floorId,
      buildingId,
      level: 1,
      scaleMmPerUnit: 1,
      rooms,
      facilities,
      exits: exits.map((f) => f.id),
      version: 0,
    };

    // 两次疏散演练样例：同楼同出口，第二次更快；第一次的问题一个已改进、一个待复查
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const mkDrill = (daysAgo: number, times: { start: string; end: string; e1: string; e2: string }, participants: number, issues: Drill['issues']): Drill => {
      const date = day(daysAgo);
      const dt = (hhmm: string) => `${date}T${hhmm}`;
      const drillId = uid();
      return {
        id: drillId,
        buildingId,
        date,
        startedAt: dt('09:00'),
        name: daysAgo > 20 ? '上半年疏散演练' : '三季度疏散演练',
        scenario: '工作日上午模拟 103 仓库电器起火',
        participants,
        fireOrigin: { floorId, roomId: rooms.find((r) => r.name === '103室')?.id, detail: '配电箱旁' },
        floors: [
          {
            floorId,
            commander: '王安全',
            participants,
            startedAt: dt(times.start),
            completedAt: dt(times.end),
            blocked: daysAgo > 20,
            blockedNote: daysAgo > 20 ? '西出口指示灯不亮，人群迟疑聚集' : undefined,
            nodes: [
              { id: uid(), kind: 'exit', label: '1F-EXIT-01', exitFacilityId: exits[0].id, time: dt(times.e1) },
              { id: uid(), kind: 'exit', label: '1F-EXIT-02', exitFacilityId: exits[1].id, time: dt(times.e2) },
            ],
          },
        ],
        issues: issues.map((i) => ({ ...i, id: uid(), drillId, foundAt: date })),
        createdAt: new Date().toISOString(),
      };
    };
    // 第一次：EXIT-01 09:04 通过、EXIT-02 09:06，09:08 撤完；两个问题
    const d1 = mkDrill(
      60,
      { start: '09:00', end: '09:08', e1: '09:04', e2: '09:06' },
      96,
      [
        {
          id: '', drillId: '', foundAt: '', description: '西安全出口（1F-EXIT-02）指示灯不亮，疏散人群迟疑',
          floorId, facilityId: exits[1].id, status: 'resolved',
          resolvedAt: day(20),
        },
        {
          id: '', drillId: '', foundAt: '', description: '103 仓库门口堆放纸箱，疏散路线变窄',
          floorId, roomId: rooms.find((r) => r.name === '103室')?.id, status: 'open',
        },
      ],
    );
    // 第二次：EXIT-01 09:03、EXIT-02 09:04，09:06 撤完，无拥堵；第一个问题已于本次复查确认改进
    const d2 = mkDrill(
      20,
      { start: '09:00', end: '09:06', e1: '09:03', e2: '09:04' },
      102,
      [],
    );
    // 回填问题归属与解决于哪次演练
    d1.issues[0].resolvedDrillId = d2.id;
    d1.issues[0].followUpNote = '指示灯已更换，第二次演练无人迟疑';
    s.drills.push(d1, d2);
  });
  persist();
  return bid;
}
