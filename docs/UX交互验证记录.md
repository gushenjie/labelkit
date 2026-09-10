# UX 交互专项验证记录

日期：2026-09-10。第一阶段仅 PC，后端接口不变。结论：本阶段实现及下列受控回归通过；代理视觉评审不代表用户已认可主观风格。

## 1. 验证对象与采用方案

基线为提交 `a99daee`，通过临时 detached worktree 启动原版前端；改后使用当前工作区。两者使用同一组模拟任务，包含运行、完成、失败和可续训状态。临时 worktree 与对比服务已移除，录像保留。所有测试 API 均拦截，没有启动真实训练、删除项目或改动业务数据。

- 视图切换：保留任务 ID 和首个可见任务的滚动锚点，仅可见身份区平移 280ms；不缩放文字，其他字段按新布局就位。布局读取完成后再启动动画。滚动、筛选、视口改变或反向切换取消旧动画。
- 数据更新：读数立即使用真实值，320ms 替换反馈；进度填充单独过渡，未知总数显示“—”。未变化的数据不重播。筛选外任务立即 inert，最多 160ms 退出。
- 弹层：业务状态与视觉存在分离，退出保留不可交互快照；确认只兑现一次，关闭归还焦点。续训输入不受轮询覆盖，失败后可重试。
- 公共接入：Select、分段切换、确认框、Toast、统计值、TaskProgress、骨架屏。任务中心采用统一基础能力；其它页面的专属转场仍未推广。

## 2. 最终回归

在 `web` 目录运行 `npx playwright test --config playwright.ux.config.ts`：**10/10 通过**，无浏览器未捕获异常。运行 `npx --no-install tsc --noEmit --incremental false` 通过；现有单元测试 **23/23 通过**；`git diff --check` 通过。

| 验证项 | 结果及边界 |
|---|---|
| 视图连续性 | 保留锚点；边界允许时偏移误差 ≤1px；10 次快速反向切换、滚动与切换中筛选后终态正确，无残留 transform |
| 卡片对齐 | 1440×900、1920×1080、1366×768：状态纵向偏移差 ≤1px，按钮不越界，页面无横向溢出；保留现有 PC 列数断点，大屏四列 |
| 数据反馈 | 更新 42%、相同数据轮询不重播、完成后离开运行筛选、初次失败重载、刷新失败保留旧数据后重试 |
| 弹层与权限 | 续训输入经轮询及失败保持；两次主动重试对应两次模拟请求；确认双击只兑现一次，退出中立即重开不被旧回调关闭 |
| 键盘与降级 | Tab/Shift+Tab 焦点约束、Escape 关闭与焦点归还；Select 跳过禁用项；分段方向键；三种 PC 尺寸减少动态效果模式 |
| 公共调用方 | 项目删除确认取消时请求数为零；素材、复查展开机器预审、训练页面的公共进度均呈现 30%；开发样例覆盖 Select、Toast、分段、确认和进度 |
| 性能 | 独立性能项目禁用录像/DOM trace，预热后 10 次切换，PerformanceObserver 的 >50ms 长任务记录为空；无逐帧 React state 更新 |

性能边界：开启视频与 DOM trace 的前轮运行出现过 53ms，以及 55–100ms 的长任务，不能把这些结果抹去。拆分采集后定向复验和最终整套回归均通过独立性能门槛；这表明当前设备、受控场景下通过，不证明采集开销是全部原因，也不承诺低性能设备或真实大数据量无卡顿。录像用于视觉判断，性能 JSON 用于独立测量。

前轮测试校准：复查进度需点击“机器预审”展开；模拟数据应保留待复查数量，避免进入“全部确认完成”的不同页面分支。续训提交未结束时 Escape 按业务契约被阻止，测试改为等待恢复可提交状态后检查关闭。

## 3. 视觉证据与评审

- [修改前录像](../web/artifacts/ux-before/ux-motion-comparison-recor-7ffbe-the-three-task-interactions/video.webm)
- [修改后录像](../web/artifacts/ux-validation/ux-motion-comparison-recor-7ffbe-the-three-task-interactions-visual/video.webm)
- [改后接触表](../web/artifacts/ux-validation/comparison-filmstrip.jpg)
- [1920 卡片截图](../web/artifacts/ux-validation/ux-motion-card-alignment-and-reduced-motion-1920-visual/viewport.png)
- [1440 卡片截图](../web/artifacts/ux-validation/ux-motion-card-alignment-and-reduced-motion-1440-visual/viewport.png)
- [1366 卡片截图](../web/artifacts/ux-validation/ux-motion-card-alignment-and-reduced-motion-1366-visual/viewport.png)
- [最终自动化结果与性能附件](../web/artifacts/ux-results.json)

依据 kinggu-design 与项目 UI 审查要求，检查了截图、录像抽帧及结构/交互断言。青绿主题与页面结构保持；卡片静止时不反复入场，hover 不抬升整卡，数字变化局部提示，不以假计数抢占阅读；弹框遮罩淡入、内容短距离进入，关闭保留内容。身份区没有缩放，静止终态没有残留位移。当前代理评审接受该方案，无须启用纯内容交接替代方案；用户主观体验仍待实际使用反馈。

上述产物保存在本地 `web/artifacts`，属于测试输出，重新运行会覆盖同名目录，不作为已提交 Git 的永久附件。

## 4. 剩余推广清单

- 其它业务页面专属状态转场、标注画布保存/撤销反馈，后续按流程验收。
- 真实网络波动、大数据量与生产构建的长期性能观测；本次模拟回归不代替后端端到端验收。
- 手机端布局与交互明确排除在第一阶段之外。
- 尚未取得用户对主观动效风格的最终认可；没有执行 Git 提交或推送。
