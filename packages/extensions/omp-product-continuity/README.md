# omp-product-continuity

运行时钉在 OMP 18.2.6。入口在 `packages/runtime/extensions/product-review.ts`。安装器把它复制到 `~/.omp/agent/extensions`。本包不写 `omp.extensions`，避免 18.2.6 把清单字段当成插件入口。
