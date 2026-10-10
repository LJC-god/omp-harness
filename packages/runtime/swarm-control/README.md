# omp-swarm-control

策略和记账在 `src/`。这里不导入 pi，也不导入 OMP。

OMP 适配器是 `adapters/omp.ts`。它只注册 `swarm_status`，真正的派发仍走唯一的 `task` shadow。宿主接口和将来的 pi 适配器写在 `docs/decomposition/SWARM-HOST-INTERFACE.md`。
