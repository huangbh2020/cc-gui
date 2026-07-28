# 拖拽文件到输入框 → 文件路径卡片

## 需求

从右栏文件树拖拽文件 → 放到中间面板的输入框 → 输入框左上角显示文件路径卡片 → 发送时路径随 prompt 一起发出 → 消息流中保持卡片状态。

## 设计决策(已确认)

- **只附加路径引用**(不读取文件内容)。卡片显示文件名,发送时把路径以 `@path` 引用注入 prompt。

## 实现方案

### 1. 扩展 ContentTag 支持 file 类型(`contentTag.ts`)

- `ContentTagKind` 加 `"file"`
- `ContentTag` 加 `filePath?: string`
- 新增 `makeFileTag(filePath): ContentTag` — `kind:"file"`, `preview`=文件名, `content`=`@path` 引用
- `composePromptWithTags` 处理 file 类型:输出 `@path` 一行(paste 类型保持现有分隔块)

### 2. FileTree 文件节点加 draggable(`FileTree.tsx`)

`FileNodeRow` 加 `draggable` + `onDragStart`,用自定义 MIME `application/x-file-path` 传路径。目录节点不加。

### 3. ChatPane composer 加 drop 目标(`ChatPane.tsx`)

composer 容器 `<div>` 加 `onDragOver`(只接受自定义 MIME)+ `onDrop`(读路径 → `makeFileTag` → `setTags`)。

### 4. ContentTagChip 区分 file 类型(`ContentTagChip.tsx`)

file 类型用 `IconFile`(非 `IconClipboard`),tooltip 显示完整路径。

### 5. 消息流持久化(`sessionStore.ts` + `MessageBlocks.tsx`)

- `Block` attachment 变体加 `attachmentKind?: "paste"|"file"` + `filePath?: string`
- `sendPrompt` 传递这两个字段(可选,向后兼容)
- `AttachmentCard` 区分 file 类型(图标 + 路径展示)

## 文件改动

| 文件 | 动作 |
|------|------|
| `lib/contentTag.ts` | 扩展类型 + `makeFileTag` + `composePromptWithTags` |
| `components/ide/FileTree.tsx` | `FileNodeRow` 加 draggable |
| `components/chat/ChatPane.tsx` | composer 加 onDragOver/onDrop |
| `components/chat/ContentTagChip.tsx` | file 类型用 IconFile |
| `stores/sessionStore.ts` | Block 扩展 + sendPrompt 传递 |
| `components/chat/MessageBlocks.tsx` | AttachmentCard 区分 file |