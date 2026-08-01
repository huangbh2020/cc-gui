## 实现计划:胶囊优化 + 计划抽屉

### 需求拆解
1. **胶囊折叠态**:只用图标显示「任务 ×1」+「计划 ×N」(N = 本会话历史中 plan 块的数量,不只是当前活跃计划)。不显示计划标题文字。
2. **胶囊展开态(弹框)**:计划只显示标题(每个计划一行),无状态徽章。
3. **点击计划标题**:在聊天区右侧滑出抽屉,显示该计划的完整 markdown 内容。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `stores/sessionStore.ts` | 新增 `planDrawerBySession` 状态(per-session:选中的计划内容)+ `openPlanDrawer`/`closePlanDrawer` action;新增 `planBlocksBySession` 派生选择器(扫描 `messagesBySession` 收集所有 `kind:"plan"` 块) |
| `components/chat/StatusCapsule.tsx` | 重写:折叠态改为图标+计数(任务、计划);展开态用 ActivityPopover 列出计划标题(点击触发抽屉) |
| `components/chat/ActivityPopover.tsx` | PlanSection 改为「计划列表」:每个 plan 块一行(标题),点击调用 `onPickPlan` 回调 |
| `components/chat/PlanDrawer.tsx` | **新建**:右侧滑出抽屉组件,显示选中计划的完整 markdown,带关闭按钮 |
| `components/chat/ChatPane.tsx` | 挂载 PlanDrawer;给 StatusCapsule 传入 planBlocks 列表 + onPickPlan 回调 |

---

### 1. sessionStore.ts — 新增状态与选择器

**新增状态字段**(在 `SessionState` 接口中,靠近 `planBySession`):
```ts
// 选中要在右侧抽屉中查看的计划文本(per-session)。null = 抽屉关闭。
planDrawerPlanBySession: Record<string, string | null>;
```

**新增 actions**:
```ts
openPlanDrawer: (sessionId: string, plan: string) => void;
closePlanDrawer: (sessionId: string) => void;
```
- `openPlanDrawer`: 设置 `planDrawerPlanBySession[sid] = plan`
- `closePlanDrawer`: 设置为 `null`
- 初始值 `{}`;在 session 切换/重置时一并清空(与 `planBySession` 同位置清理)。

**不新增 planBlocks 选择器到 store**:plan 块列表在 ChatPane 中用 `useMemo` 从 `messages` 中扫描得到(复用现有 `beforeMap` 扫描模式,ChatPane.tsx:456-466),避免 store 频繁更新。扫描逻辑:
```ts
const planBlocks = useMemo(
  () => messages.flatMap((m) => m.blocks).filter((b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan"),
  [messages],
);
```

---

### 2. StatusCapsule.tsx — 重写折叠态 + 传参变更

**Props 变更**:
```ts
export function StatusCapsule({
  subagents,
  todos,
  planCount,        // 新增:planBlocks.length
  planBlocks,       // 新增:所有 plan 块(用于展开态列出标题)
  onPickPlan,       // 新增:(plan: string) => void,点击计划标题触发抽屉
}: { ... })
```
删除 `plan: PlanDraft` prop(不再需要单一当前计划)。

**折叠态(按钮内)**:
- 计划段:`IconClipboard` + `×{planCount}` (仅在 planCount > 0 时显示)
- 任务段:`IconListDetails` + `{todoDone}/{todos.length}` (保持不变)
- 子代理段:`IconRobot` + count (保持不变)
- 不再显示计划标题文字,只用图标+计数。

**展开态**:仍挂载 `<ActivityPopover>`,但传入 `planBlocks` + `onPickPlan`。

**渲染门槛**:`if (!hasSubagents && !hasTodos && planCount === 0) return null`

**ChatPane 挂载处门槛**:同步改为 `todos.length > 0 || subagents.length > 0 || planBlocks.length > 0`。

---

### 3. ActivityPopover.tsx — PlanSection 改为计划列表

**Props 变更**(root ActivityPopover):
```ts
export function ActivityPopover({
  todos,
  planBlocks,    // 替代 plan: PlanDraft
  subagents,
  onPickPlan,    // 新增
}: {
  todos: TodoItem[];
  planBlocks: PlanBlockEntry[];   // { plan: string; phase; hasApproval? }[]
  subagents: SubagentSnapshot[];
  onPickPlan: (plan: string) => void;
})
```

**PlanSection → PlanListSection**:不再显示单个计划内容,改为列表:
```
📋 计划文档 (N)
  ├ 计划标题 1     ← 点击 → onPickPlan(plan1) → 关闭 popover + 打开抽屉
  ├ 计划标题 2
  └ 计划标题 3
```
- 每行:`extractPlanTitle(block.plan)`(从 StatusCapsule 提取到共享位置),truncate 防溢出,hover 高亮,click 调用 `onPickPlan`。
- 无状态徽章。
- `showPlan = planBlocks.length > 0`。

**extractPlanTitle 共享化**:从 StatusCapsule.tsx 移到独立位置(`@renderer/lib/planTitle.ts`)或直接在 ActivityPopover 内引用。为减少文件改动,在 ActivityPopover 中导入 StatusCapsule 导出的 `extractPlanTitle`。

---

### 4. PlanDrawer.tsx — 新建右侧滑出抽屉

```tsx
export function PlanDrawer({ plan, onClose }: { plan: string; onClose: () => void }) {
  return (
    // absolute right-0 top-0 bottom-0,从右侧滑入
    // 宽度 ~420px,带左侧阴影边框
    // 顶部:标题栏 "计划内容" + 关闭按钮(IconX)
    // 主体:可滚动区域,Markdown 渲染完整 plan
    <div className="absolute right-0 top-0 bottom-0 z-40 w-[420px] border-l border-edge bg-surface shadow-2xl animate-[slide-in-right_140ms_ease-out] flex flex-col">
      <header>...</header>
      <div className="flex-1 overflow-auto p-4">
        <Markdown>{plan}</Markdown>
      </div>
    </div>
  );
}
```
- 定位:`absolute` 相对于 ChatPane 根 `relative flex h-full flex-col`(ChatPane.tsx:1003),覆盖消息流 + 输入框右侧条带。
- 动画:新增 `slide-in-right` keyframe(在 styles.css 中,或复用 `translate-x` transition)。
- z-40 在 StatusCapsule(z-30)之上,点击胶囊关闭 popover 后抽屉出现。

---

### 5. ChatPane.tsx — 连接所有部件

**新增选择器**:
```ts
const drawerPlan = useSessionStore((s) => s.planDrawerPlanBySession[sessionId] ?? null);
const openPlanDrawer = useSessionStore((s) => s.openPlanDrawer);
const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);
```

**planBlocks memo**(复用 beforeMap 扫描模式):
```ts
const planBlocks = useMemo(
  () => messages.flatMap((m) => m.blocks).filter((b): b is PlanBlock => b.kind === "plan"),
  [messages],
);
```

**StatusCapsule 调用改为**:
```tsx
<StatusCapsule
  subagents={subagents}
  todos={todos}
  planCount={planBlocks.length}
  planBlocks={planBlocks}
  onPickPlan={(plan) => {
    openPlanDrawer(sessionId, plan);
    // popover 自动关闭(StatusCapsule 内部在 onPickPlan 后 setOpen(false))
  }}
/>
```

**PlanDrawer 挂载**(在 ChatPane 根 div 内,消息流区域之后):
```tsx
{drawerPlan && <PlanDrawer plan={drawerPlan} onClose={() => closePlanDrawer(sessionId)} />}
```

---

### 6. session 清理

在 session reset / 切换的现有清理点(与 `planBySession` 并列的位置,如 `resetSession`、`selectSession` 等已清理 plan 的地方),同步清理 `planDrawerPlanBySession[sid]`。

---

### 实现顺序
1. sessionStore:新增 `planDrawerPlanBySession` 状态 + actions + 清理点
2. 新建 PlanDrawer.tsx
3. 重写 StatusCapsule.tsx(折叠态图标+计数,导出 extractPlanTitle)
4. 改 ActivityPopover.tsx(PlanSection → 计划标题列表)
5. 改 ChatPane.tsx(planBlocks memo + 传参 + 挂载 PlanDrawer)
6. typecheck 验证