# Skill 详情版本信息去重实施计划

## 步骤

1. 在 `skillFormatting.ts` 中新增详情版本展示值归一化函数。
2. 在 `skillFormatting.test.ts` 中覆盖优先字段、兼容字段和空字段场景。
3. 修改 `SkillsWorkspacePanel.tsx`，只渲染归一化后的市场版本和本地版本。
4. 运行相关单元测试、TypeScript、ESLint 和客户端构建。
5. 在本地技能市场打开 `frontend-polisher`，确认版本和创建者各显示一次。

## 完成标准

- 市场版本优先 `marketVersion`，回退 `version`。
- 本地版本优先 `localVersion`，回退 `importedVersion`。
- 原始接口对象不被修改。
- `frontend-polisher` 详情只显示“市场版本 v3 / 本地版本 v3 / 创建者 design-team”。
