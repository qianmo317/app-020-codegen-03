/**
 * 疏散演练 store 测试：新建默认带出楼层、新增楼层给旧演练补记录、
 * 节点/问题写入替换引用（useSyncExternalStore 订阅语义）、删除楼层与建筑的级联。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  subscribe,
  getState,
  addBuilding,
  deleteBuilding,
  addFloor,
  addDrill,
  deleteDrill,
  updateDrill,
  setDrillFloorRecord,
  addDrillNode,
  updateDrillNode,
  moveDrillNode,
  removeDrillNode,
  addDrillIssue,
  resolveDrillIssue,
  deleteFloor,
} from '../src/store/store';

const snap = () => getState();
const D = '2026-09-20';
const t = (h: string) => `${D}T${h}`;

let bid = '';
let f1 = '';
let f2 = '';

beforeEach(() => {
  for (const b of [...snap().buildings]) deleteBuilding(b.id);
  bid = addBuilding('演练测试楼', 'office');
  f1 = addFloor(bid, 1);
  f2 = addFloor(bid, 2);
});

describe('演练新建与楼层联动', () => {
  it('D1 新建演练默认带出建筑全部楼层空记录；顺序与楼层一致', () => {
    const id = addDrill(bid, D);
    const d = snap().drills.find((x) => x.id === id)!;
    expect(d.floors.map((r) => r.floorId)).toEqual([f1, f2]);
    expect(d.floors[0].nodes).toEqual([]);
    expect(d.fireOrigin).toEqual({});
  });

  it('D2 演练之后新增楼层：旧演练自动补一层，已有数据不被覆盖', () => {
    const id = addDrill(bid, D);
    setDrillFloorRecord(id, f1, { commander: '张三' });
    const f3 = addFloor(bid, 3);
    const d = snap().drills.find((x) => x.id === id)!;
    expect(d.floors.map((r) => r.floorId)).toEqual([f1, f2, f3]);
    expect(d.floors[0].commander).toBe('张三');
    expect(d.floors[2].commander).toBe('');
  });

  it('D3 删除楼层：演练摘掉该层；挂在该层的问题保留描述但摘掉定位', () => {
    const id = addDrill(bid, D);
    const iid = addDrillIssue(id, { description: '2F 楼梯灯不亮', floorId: f2, foundAt: D });
    deleteFloor(f2);
    const d = snap().drills.find((x) => x.id === id)!;
    expect(d.floors.map((r) => r.floorId)).toEqual([f1]);
    const issue = d.issues.find((x) => x.id === iid)!;
    expect(issue.description).toBe('2F 楼梯灯不亮');
    expect(issue.floorId).toBeUndefined();
  });

  it('D4 删除建筑连带删除其全部演练，其他建筑不受影响', () => {
    const id = addDrill(bid, D);
    const bid2 = addBuilding('另一栋', 'retail');
    const fx = addFloor(bid2, 1);
    const id2 = addDrill(bid2, D);
    deleteBuilding(bid);
    const ids = snap().drills.map((d) => d.id);
    expect(ids).not.toContain(id);
    expect(ids).toContain(id2);
    expect(snap().floors[fx]).toBeDefined();
  });

  it('D5 删除演练后不可见', () => {
    const id = addDrill(bid, D);
    deleteDrill(id);
    expect(snap().drills.some((d) => d.id === id)).toBe(false);
  });
});

describe('楼层记录与节点写入（引用语义）', () => {
  it('D6 头字段与楼层字段更新替换演练对象引用，订阅者收到通知', () => {
    const id = addDrill(bid, D);
    const d0 = snap().drills.find((x) => x.id === id)!;
    let notified = 0;
    const un = subscribe(() => notified++);
    updateDrill(id, { participants: 230, name: '秋演' });
    setDrillFloorRecord(id, f1, { commander: '李四', startedAt: t('09:00'), completedAt: t('09:05'), blocked: true, blockedNote: '东门' });
    un();
    expect(notified).toBe(2);
    const d1 = snap().drills.find((x) => x.id === id)!;
    expect(d1).not.toBe(d0);
    expect(d1.participants).toBe(230);
    const r = d1.floors.find((x) => x.floorId === f1)!;
    expect(r.commander).toBe('李四');
    expect(r.blockedNote).toBe('东门');
  });

  it('D7 节点增/改/排序/删：顺序即通过先后，移动只换位不改内容', () => {
    const id = addDrill(bid, D);
    const n1 = addDrillNode(id, f1, 'stair');
    const n2 = addDrillNode(id, f1, 'exit');
    updateDrillNode(id, f1, n1, { label: '西楼梯口', time: t('09:01') });
    updateDrillNode(id, f1, n2, { label: 'EXIT-01', exitFacilityId: 'fac-x', time: t('09:03') });
    let r = snap().drills.find((x) => x.id === id)!.floors.find((x) => x.floorId === f1)!;
    expect(r.nodes.map((n) => n.id)).toEqual([n1, n2]);
    expect(r.nodes[1].exitFacilityId).toBe('fac-x');
    moveDrillNode(id, f1, n2, -1);
    r = snap().drills.find((x) => x.id === id)!.floors.find((x) => x.floorId === f1)!;
    expect(r.nodes.map((n) => n.id)).toEqual([n2, n1]);
    // 已在首位不能再上移
    moveDrillNode(id, f1, n2, -1);
    r = snap().drills.find((x) => x.id === id)!.floors.find((x) => x.floorId === f1)!;
    expect(r.nodes.map((n) => n.id)).toEqual([n2, n1]);
    removeDrillNode(id, f1, n1);
    r = snap().drills.find((x) => x.id === id)!.floors.find((x) => x.floorId === f1)!;
    expect(r.nodes.map((n) => n.id)).toEqual([n2]);
  });
});

describe('问题挂账与复查', () => {
  it('D8 新问题默认 open；在另一次演练复查确认改进 → resolved 并记录解决演练/日期', () => {
    const d1 = addDrill(bid, '2026-09-01');
    const iid = addDrillIssue(d1, { description: '闭门器失效', floorId: f2, roomId: undefined, foundAt: '2026-09-01' });
    let issue = snap().drills.find((x) => x.id === d1)!.issues[0];
    expect(issue.status).toBe('open');
    expect(issue.drillId).toBe(d1);

    const d2 = addDrill(bid, '2026-10-01');
    resolveDrillIssue(iid, 'resolved', d2, '2026-10-01', '已更换');
    issue = snap().drills.find((x) => x.id === d1)!.issues.find((x) => x.id === iid)!;
    expect(issue.status).toBe('resolved');
    expect(issue.resolvedDrillId).toBe(d2);
    expect(issue.resolvedAt).toBe('2026-10-01');
    expect(issue.followUpNote).toBe('已更换');
  });

  it('D9 复查「仍存在」保持 open，不写解决日期；可标 wontfix 关闭', () => {
    const d1 = addDrill(bid, '2026-09-01');
    const iid = addDrillIssue(d1, { description: '堆物', floorId: f1, foundAt: '2026-09-01' });
    const d2 = addDrill(bid, '2026-10-01');
    resolveDrillIssue(iid, 'still_open', d2, '2026-10-01', '继续整改');
    let issue = snap().drills.find((x) => x.id === d1)!.issues.find((x) => x.id === iid)!;
    expect(issue.status).toBe('open');
    expect(issue.resolvedAt).toBeUndefined();
    expect(issue.followUpNote).toBe('继续整改');
    resolveDrillIssue(iid, 'wontfix', d2, '2026-10-01');
    issue = snap().drills.find((x) => x.id === d1)!.issues.find((x) => x.id === iid)!;
    expect(issue.status).toBe('wontfix');
    expect(issue.resolvedDrillId).toBe(d2);
  });
});
