# investment — 查看器

一个部署在 GitHub Pages 上的静态查看器。**本仓库不含任何策略内容或持仓数据。**

策略文档、筛选逻辑、每日名单和持仓全部存放在一个独立的 **private** 仓库，
本站在浏览器中用你的 Fine-grained token 于运行时取回。未解锁时页面是空壳。

```
web/          Vite + TypeScript，无运行时依赖、无 CDN、无第三方脚本
  src/
    main.ts       路由与解锁流程
    private.ts    从私有仓库读取策略、名单、持仓
    github.ts     GitHub Contents API
    markdown.ts   极简 Markdown 渲染器（策略文档从私有仓库取回后渲染）
    metrics.ts    XIRR、Sharpe、最大回撤
    store.ts      设置与 token 加密存储
```

## 为什么要拆成两个仓库

免费版 GitHub Pages 只能从公开仓库发布，任何知道网址的人都能打开站点。
把实质内容留在公开仓库等于公开发布策略和持仓。

| 仓库 | 可见性 | 内容 |
| --- | --- | --- |
| `investment`（本仓库） | 公开 | 查看器代码。界面上会出现策略代号与指标名称，但无参数、无名单、无持仓 |
| `investment-private` | 私有 | 管线代码、参数阈值、每日名单、策略文档、持仓 |

## 部署

1. Settings → Pages → Source 选 **GitHub Actions**
2. 推送到 `main` 即自动构建部署

无需任何 Secrets —— 本仓库不访问任何外部 API。

## 使用

打开站点 → 设置 → 填写：

- **Private 仓库**：`你的用户名/investment-private`
- **持仓文件路径**：默认 `holdings.json`，可改为任意路径
- **Fine-grained Token**：只授权那一个私有仓库，权限只给 Contents: Read and write
- **加密口令**：可选但建议。填了之后 token 以 AES-GCM 加密存于 localStorage

## 本地开发

```bash
npm install --prefix web && npm run dev --prefix web
```

## 免责

个人自用的研究与纪律工具，非投资建议，作者不是持牌投资顾问。
所有回测均未扣除交易成本、买卖价差与税。历史表现不代表未来。
