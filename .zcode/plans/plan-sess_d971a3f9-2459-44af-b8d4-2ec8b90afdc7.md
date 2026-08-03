# 输入框 / 命令面板优化方案

## 目标(3 项)

1. **命令面板分 tab**:Slash Commands(内置 `/compact`、`/init`)与 Skill 分开,用 tab 切换;默认 Skill tab,智能切换。
2. **下箭头首行选中**:面板打开后按 ↓ 选中第一行(当前初始 `activeIdx=0` 已是第一行,但 ↓ 的边界钳制 `Math.min(len-1, i+1)` 在已为 0 时仍停在 0,视觉上无"选中第一行"的明确反馈 → 需确保 ↓ 总能进入选中态并滚动到首行)。
3. **Skill pill 背景色对齐卡片风格**:参考 `ContentTagChip` 的背景(`bg-accent/10`、`border-accent/40`),调整 `SkillPill` 的 `HTMLAttributes.class`。

---

## 改动清单(5 个文件)

### 文件 1: `apps/desktop/src/renderer/lib/slashCommands.ts`(数据层)
- 新增 `BuiltInCommand` 类型与 `BUILT_IN_COMMANDS` 常量数组,包含两条:
  - `{ name: "compact", description: "压缩对话历史(总结并释放上下文)", kind: "compact" }`
  - `{ name: "init", description: "生成项目说明文件 AGENTS.md", kind: "init" }`
- 新增 `filterBuiltInCommands(query)`:与 `filterSkillCommands` 同样的大小写不敏感匹配。
- 导出一个判别联合类型 `SlashEntry = SkillInfo | BuiltInCommand`,供 picker 统一渲染。`BuiltInCommand` 用 `kind: "compact" | "init"` 字段区分于 skill(后者无该字段)。

### 文件 2: `apps/desktop/src/renderer/components/chat/SlashCommandPicker.tsx`(UI 重构)
这是改动量最大的文件。改造为 tab 化面板:

**Props 调整**:
- 保留 `open` / `query` / `skills` / `anchorRect` / `onClose`。
- `onPick` 拆分为两个回调:`onPickSkill(skill: SkillInfo)` 与 `onPickCommand(cmd: BuiltInCommand)`,由父组件 `ChatPane` 分别处理(一个插入 pill,一个直接执行/填充)。

**内部状态**:
- `activeTab: "skill" | "command"`,默认 `"skill"`(满足"默认显示 Skill")。
- `activeIdx` 沿用,在 tab 切换 / query 变化时重置为 0。
- 当前 tab 的列表:`tab === "skill" ? filterSkillCommands(query, skills) : filterBuiltInCommands(query)`。

**智能切换逻辑**(在 `query` / `open` 变化的 effect 里):
- 计算两个 tab 的过滤结果 `skillCmds` / `builtinCmds`。
- 若当前 tab 结果为空且另一 tab 非空 → 自动切到另一 tab。
- 两个 tab 都空 → 维持当前,显示空态。

**Tab 栏 UI**(面板头部,替换原 "Skill 命令" 标题行):
```
[ ✦ Skill (n) ]  [ ⌘ 命令 (2) ]      ← 两个可点击 tab 按钮
```
- 选中 tab 用 `border-b-2 border-accent text-content`,未选用 `text-content-muted`。
- 数字角标显示各自结果数。

**列表项渲染**:
- skill 项:沿用现有渲染(`/name` + 描述 + 来源标签 + `IconSparkles`)。
- 命令项:`/compact` / `/init` + 描述,用 `IconCommand` 图标区分,加一个"内置"小标签(替代来源标签)。

**箭头修复(第 2 项需求)**:
- `ArrowDown`:`setActiveIdx((i) => (i + 1) % commands.length)` 改为循环?不——需求是"按 ↓ 选中第一行"。当前 `activeIdx=0` 已是首行,但用户反馈"按 ↓ 没反应"。根因:面板刚打开时 `activeIdx=0`,视觉上首项已有 `bg-accent/12` 高亮,但用户按 ↓ 期望看到明确的"选中"。修复:
  - 保持 `activeIdx` 初值 0(首行已选中)。
  - `ArrowDown`:`Math.min(commands.length - 1, i + 1)` → 保持(向下移动)。
  - **关键修复**:确保面板打开时 `activeIdx` 强制为 0(已有 effect),并确保首项始终有高亮样式(已有 `isActive` 判断)。额外:若 `commands.length > 0` 且 `activeIdx` 因某种原因为 -1,按 ↓ 时强制设为 0。
  - 实际上更可能的问题是:面板由 `recomputePicker` 在 `pickerKind` 从 null→slash 时打开,但 `activeIdx` 的重置 effect 依赖 `[query, open]`——而 `open` 在 React 中是 `pickerKind === "slash"` 的派生值,首次打开时 query 为空字符串,可能不触发重置。**修复**:effect 依赖改为 `[query, activeTab, open]`,并在 `activeTab` 变化时也重置。
  - 同步修复 `FileMentionPicker.tsx` 的相同逻辑(把 `activeIdx` 重置 effect 的依赖补全),保持两个 picker 行为一致。

**底部提示行**:沿用,数字改为当前 tab 的结果数。

### 文件 3: `apps/desktop/src/renderer/components/chat/ChatPane.tsx`(父组件接线)
- 在 `handleSlashPick` 旁新增 `handleBuiltInPick(cmd: BuiltInCommand)`:
  - `cmd.kind === "compact"`:先 `clearTriggerToken()`(清掉 `/compact` 触发文本),再调用 `sendPrompt("/compact")` 直接发送。运行中(`sessionBusy`)时禁用(在 picker 层传入 `disabled` 或在此处 return)。
  - `cmd.kind === "init"`:调用 `clearTriggerToken()`,然后用 `editorRef.current?.setText(...)` 填入一段可编辑的 init 提示词模板(如 `"请分析当前项目的代码结构、技术栈和约定,在项目根目录生成一份 AGENTS.md 说明文件,指导 AI agent 如何参与开发。"`),用户可修改后按 Enter 发送。
- JSX:`<SlashCommandPicker onPickSkill={handleSlashPick} onPickCommand={handleBuiltInPick} ... />`,替换原 `onPick`。
- 传 `sessionBusy` 给 picker 以禁用 compact(运行中不允许再压缩)。

### 文件 4: `apps/desktop/src/renderer/components/chat/ComposerEditor.tsx`(pill 样式)
- `SkillPill` 的 `HTMLAttributes.class`(第 144-148 行):从
  ```
  border-accent/50 bg-accent/25 ... text-accent
  ```
  改为对齐 `ContentTagChip` 风格:
  ```
  border-accent/40 bg-accent/10 ... text-accent hover:border-accent/70 hover:bg-accent/20
  ```
  (与 `ContentTagChip` 非激活态一致:`border-accent/40 bg-accent/10`)

### 文件 5: `apps/desktop/src/renderer/components/chat/FileMentionPicker.tsx`(箭头一致性)
- `activeIdx` 重置 effect(约 36-38 行对应位置)依赖补全,与 SlashCommandPicker 保持一致,确保打开时首行选中。

---

## 不做的事(明确边界)

- **不新增 IPC 通道**:`/compact` 作为普通 prompt 通过现有 `claude:sendTurn` 发送;`/init` 也是 prompt。无需改 contracts / main 进程。
- **不处理 SDK 的 `compact_boundary` / `status:compacting` 消息**:这些目前被 `SdkMessageAdapter` 静默忽略。本次只做前端"发送 /compact"的入口;压缩成功后 agent 会正常返回 turn.done,UI 自然刷新。后续若要显示"压缩中"徽标再单独处理(超出本次需求范围)。
- **不改 `filterSkillCommands` 现有签名**,新增并列的 `filterBuiltInCommands`。
- **不改 `FileMentionPicker` 的 tab 结构**:`@` 文件引用不需要 tab。

---

## 验证步骤

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查通过。
2. 运行 `pnpm dev`,在输入框输入 `/`:
   - 面板打开,默认 Skill tab,首行高亮选中。
   - 按 ↓ 能向下移动(从首行到第二行),按 ↑ 回到首行。
   - 点 "命令" tab 切换,显示 `/compact`、`/init`。
   - 输入 `/co` → Skill tab 无结果,自动切到命令 tab 显示 `/compact`。
   - 选中 skill → 插入 pill,样式与左上角卡片(背景 `bg-accent/10`)一致。
   - 选中 `/compact` → 直接发送,输入框清空。
   - 选中 `/init` → 输入框填入可编辑提示词,光标可继续编辑。
