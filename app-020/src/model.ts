/** 全局数据模型 —— 坐标一律为毫米（mm），距离限值/实测为米（m） */
export type Pt = { x: number; y: number };

export type RoomUsage = 'office' | 'retail' | 'storage' | 'ward' | 'corridor' | 'other';

export type Room = {
  id: string;
  polygon: Pt[];
  name: string;
  usage: RoomUsage;
  areaM2: number;
  occupants?: number;
};

export type FacilityKind =
  | 'extinguisher'
  | 'hydrant'
  | 'exit_sign'
  | 'emergency_light'
  | 'exit'
  | 'sprinkler';

export type CheckStatus = 'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing';

export type CheckRecord = {
  date: string; // YYYY-MM-DD
  status: CheckStatus;
  photoKey?: string; // IndexedDB key，照片仅存本地
  note?: string;
};

export type Facility = {
  id: string;
  kind: FacilityKind;
  x: number; // mm
  y: number; // mm
  code: string; // 楼层-类型-序号，如 3F-EX-01
  spec?: {
    extType?: 'dry_powder' | 'co2' | 'water';
    weightKg?: number;
  };
  checks: CheckRecord[];
};

export type Underlay = {
  key: string; // IndexedDB key
  wPx: number;
  hPx: number;
  offsetX: number; // mm，底图左上角在图纸坐标中的位置
  offsetY: number;
  scaleMmPerPx: number; // 仅影响底图显示，不影响校验
  opacity: number; // 0~1
  visible: boolean;
};

export type Floor = {
  id: string;
  buildingId: string;
  level: number; // 1,2,3... 地下为 -1,-2
  scaleMmPerUnit: number; // 兼容字段：毫米坐标存储，此值仅影响底图显示
  rooms: Room[];
  facilities: Facility[];
  exits: string[]; // kind === 'exit' 的设施 id
  underlay?: Underlay;
  version: number; // 每次编辑 +1，用于触发校验
  lastValidation?: ValidationResult;
};

export type BuildingKind = 'office' | 'retail' | 'factory' | 'school';

export type Building = {
  id: string;
  name: string;
  kind: BuildingKind;
  floors: string[];
  createdAt: string;
};

export type RuleSet = {
  buildingKind: BuildingKind;
  maxTravelDistanceM: number;
  deadEndDistanceM: number;
  extinguisherRadiusM: number;
  exitMinAreaM2: number; // 超过此面积需 ≥2 个安全出口
  exitMaxOccupants: number; // 超过此人数需 ≥2 个安全出口
  source: string; // 依据文号，报告中打印
  version: number; // 规则版本，修改即 +1，校验结果记录当时版本
};

export type ValidationSeverity = 'error' | 'warning';

export type ValidationItem = {
  severity: ValidationSeverity;
  type: string;
  message: string;
  roomId?: string;
  facilityId?: string;
  point?: Pt; // 图纸定位点 mm
  value?: number; // 实测值（m / m²）
  limit?: number;
};

export type ValidationResult = {
  checkedAt: string;
  pass: boolean;
  items: ValidationItem[];
  travelWorstM: number | null;
  travelWorstPoint?: Pt | null;
  deadEndM: number | null;
  coverage: { uncoveredM2: number; totalM2: number; pass: boolean; samples: Pt[] } | null;
  exits: { present: number; required: number };
  rulesSnapshot: {
    buildingKind: BuildingKind;
    version: number;
    source: string;
    maxTravelDistanceM: number;
    deadEndDistanceM: number;
    extinguisherRadiusM: number;
  };
};

// ---------- 疏散演练 ----------

/** 疏散路线关键节点类型：楼梯口（层间节点）或出口（离楼节点） */
export type DrillNodeKind = 'stair' | 'exit';

/**
 * 路线关键节点通过记录。节点按顺序组成该层的疏散路线：
 * 上一层的末端楼梯口与本层首个楼梯口表示同一段楼梯（跨层段在统计时单独标记）。
 */
export type DrillNode = {
  id: string;
  kind: DrillNodeKind;
  /** 节点名称：自由文本（如「东楼梯口」）或出口设施 code（1F-EXIT-01） */
  label: string;
  /** 关联的出口设施 id（kind==='exit' 时，用于出口使用频次统计） */
  exitFacilityId?: string;
  /** 首次通过时刻 'YYYY-MM-DDTHH:mm[:ss]'，空串表示未记录 */
  time: string;
};

/** 按楼层记录的演练数据 */
export type DrillFloorRecord = {
  floorId: string;
  commander: string; // 本层疏散指挥
  participants: number | null; // 本层参演人数（总人数之外的分层计数，可空）
  startedAt: string; // 本层开始时刻
  completedAt: string; // 本层结束时刻（最后一人撤离本层）
  blocked: boolean; // 有没有堵在楼道口
  blockedNote?: string; // 拥堵位置/情况说明
  /** 路线关键节点（楼梯口、出口），按通过先后排序 */
  nodes: DrillNode[];
  note?: string;
};

/** 假设起火点 */
export type FireOrigin = {
  floorId?: string;
  roomId?: string;
  /** 楼层/房间之外的补充描述（如「配电井旁」），也可在未选房间时单独使用 */
  detail?: string;
};

export type DrillIssueStatus = 'open' | 'resolved' | 'wontfix';

/** 演练发现的问题：挂到具体房间或设施上，供下次演练复查 */
export type DrillIssue = {
  id: string;
  drillId: string; // 发现该问题的演练
  description: string;
  floorId?: string; // 定位：楼层
  roomId?: string; // 定位：房间（与 facilityId 二选一或并存）
  facilityId?: string; // 定位：设施
  foundAt: string; // YYYY-MM-DD
  status: DrillIssueStatus;
  /** 在哪次演练中确认改进（复查通过时回填） */
  resolvedDrillId?: string;
  resolvedAt?: string;
  followUpNote?: string;
};

export type Drill = {
  id: string;
  buildingId: string;
  date: string; // YYYY-MM-DD
  /** 演练开始时刻（全楼统一计时起点），可仅精确到分 */
  startedAt: string;
  name?: string; // 备注名，如「三季度全员演练」
  scenario?: string; // 场景说明
  participants: number | null; // 参演总人数
  fireOrigin: FireOrigin;
  floors: DrillFloorRecord[];
  issues: DrillIssue[];
  createdAt: string;
};

export const DRILL_NODE_LABELS: Record<DrillNodeKind, string> = {
  stair: '楼梯口',
  exit: '出口',
};

export const DRILL_ISSUE_STATUS_LABELS: Record<DrillIssueStatus, string> = {
  open: '待改进',
  resolved: '已改进',
  wontfix: '不处理',
};

export const FACILITY_LABELS: Record<FacilityKind, string> = {
  extinguisher: '灭火器',
  hydrant: '消火栓',
  exit_sign: '疏散指示灯',
  emergency_light: '应急照明',
  exit: '安全出口',
  sprinkler: '喷淋',
};

export const FACILITY_CODES: Record<FacilityKind, string> = {
  extinguisher: 'EX',
  hydrant: 'HY',
  exit_sign: 'ES',
  emergency_light: 'EL',
  exit: 'EXIT',
  sprinkler: 'SP',
};

export const USAGE_LABELS: Record<RoomUsage, string> = {
  office: '办公',
  retail: '商业',
  storage: '仓库',
  ward: '病房',
  corridor: '走道',
  other: '其他',
};
