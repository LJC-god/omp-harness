# 抽出的运行时

OMP 18.2.6 扩展的编辑处。`extensions/` 里的文件由 `scripts/stage-extract.mjs` 从冻结快照生成，并改写宿主导入、路径和环境。重新生成：

```bash
node scripts/stage-extract.mjs
```

安装器把 `extensions/` 和 `lib/` 复制到 `$OMP_HOME/agent`。逻辑包名在 `packages/extensions/`。

验收：

```bash
bun install
bun test/acceptance.ts
```

验收要求已安装的 `@oh-my-pi/pi-coding-agent` 正好是 18.2.6。
