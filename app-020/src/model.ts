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

// ---------- 疏散演练 ----------

export type NodeKind = 'stair' | 'exit';

/** 疏散路线关键节点：楼梯口或出口，按数组顺序即路线顺序 */
export type DrillNode = {
  id: string;
  kind: NodeKind;
  name: string; // 如「东楼梯口」「1F-EXIT-01 东门」
  floorId?: string; // 节点所在楼层
  facilityId?: string; // 关联安全出口设施（出口使用次数统计按它归并）
};

/** 按楼层记录的疏散情况 */
export type DrillFloorRecord = {
  floorId: string;
  commander: string; // 本层疏散指挥
  start?: string; // HH:mm 或 HH:mm:ss
  end?: string;
  blocked: boolean; // 是否堵在楼道口
  note?: string;
};

/** 关键节点的一次通过时间 */
export type NodePass = {
  nodeId: string;
  at?: string;
};

/** 问题挂接对象：具体房间、具体设施，或仅文字描述的位置 */
export type IssueTarget =
  | { kind: 'room'; floorId: string; roomId: string }
  | { kind: 'facility'; floorId: string; facilityId: string }
  | { kind: 'other'; floorId?: string; label: string };

export type IssueStatus = 'open' | 'fixed' | 'wontfix';
export type FollowUpResult = 'fixed' | 'still' | 'worse';

export type DrillFollowUp = {
  drillId: string; // 复查发生在哪次演练
  result: FollowUpResult; // 已改进 / 仍存在 / 加重
  note?: string;
  at: string;
};

/** 演练中发现、并挂到具体房间/设施上的问题，跨演练跟踪整改 */
export type DrillIssue = {
  id: string;
  buildingId: string;
  drillId?: string; // 首次发现于哪次演练
  target: IssueTarget;
  description: string;
  status: IssueStatus;
  createdAt: string;
  followUps: DrillFollowUp[];
};

export type Drill = {
  id: string;
  buildingId: string;
  date: string; // YYYY-MM-DD
  alarmAt: string; // HH:mm(:ss) 假设起火 / 警报时间
  fireFloorId?: string; // 假设起火点：楼层
  fireRoomId?: string; // 假设起火点：房间（可空，仅填文字）
  fireNote?: string;
  participants: number; // 参演人数
  nodes: DrillNode[]; // 路线节点，有序
  floors: DrillFloorRecord[]; // 各层记录
  passes: NodePass[]; // 各节点通过时间
  note?: string;
  createdAt: string;
};

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  stair: '楼梯口',
  exit: '出口',
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待整改',
  fixed: '已整改',
  wontfix: '不整改',
};

export const FOLLOWUP_LABELS: Record<FollowUpResult, string> = {
  fixed: '已改进',
  still: '仍存在',
  worse: '加重',
};

export const USAGE_LABELS: Record<RoomUsage, string> = {
  office: '办公',
  retail: '商业',
  storage: '仓库',
  ward: '病房',
  corridor: '走道',
  other: '其他',
};
