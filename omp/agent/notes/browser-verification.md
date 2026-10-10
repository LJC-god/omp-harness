# OMP browser verification recipes

Read only when operating a browser or preview. Checked against installed OMP 18.1.19 source on 2026-09-13; inspect the installed contract again after an incompatible runtime change. This is a tool reference, not another gate, design skill or E2E framework. Source references: pi-coding-agent/src/prompts/tools/browser.md, src/tools/browser.ts, src/tools/browser/tab-worker.ts and src/tools/hub/launch.ts in the installed package.

## Preview and execution contexts

- Final visual acceptance uses the project's existing production build/preview command when supported. Build once for the current source; a repair that changes it may require rebuilding. Check HTTP readiness plus a rendered application selector, not a fixed sleep or a log line alone. A development overlay is not proof of a production defect.
- Reuse a task-owned preview until all assigned consumers finish. Name one production-preview owner; only that owner restarts/builds it. Reviewers use separate accounts/data and record owner, command, URL, source/commit and mode in D: evidence outside source from the first call. Do not stop another task's server or close all browser tabs. A later build does not turn existing dev-server images into production-preview evidence.
- For local application acceptance, choose the already verified project runner or installed playwright-cli before starting the journey; carry its exact working invocation into follow-ups. Do not retry the known native action timeout through alternate click wrappers. Observation-only native Eval remains available. For a user's authenticated existing browser, preserve the requested profile/login context instead of silently substituting a fresh Playwright profile. Inspect the actual relay connection/profile/extension contract before asking the user to change settings.
- On Windows, discover the actual launcher (`Get-Command pnpm`, project scripts) before hub.start. Prefer the resolved executable plus argument array. A .cmd/.bat entry requires cmd.exe with /d /s /c and the batch path correctly quoted; do not pass an entire shell command as application. A resolved Node executable plus the project's actual CLI JS path avoids batch quoting. Use hub's installed start schema (`application`, `args`, `cwd`); inspect it rather than inventing command/program fields. Use a unique process name and hidden startup.
- For a Windows background service, `Start-Process -WindowStyle Hidden` or Node `{ windowsHide: true }` is only the first step: verify that descendants have no visible consoles and verify service lifecycle before treating it as ready. Assign one runtime owner, retain that run's data and logs under its `D:/Labs/omp` directory, and use scoped graceful cleanup only for identified owned processes when authorized run consumers finish or on an explicit user stop. Never kill unknown processes or use global kill-all; an actual user cancellation never authorizes automatic resume.
- Native Eval has `browser`; it has no global page DOM. `tab.run(async ({ page }) => ...)` receives a raw Puppeteer page. BrowserTab is not that page. DOM reads belong in `tab.evaluate(() => ...)` or `page.evaluate(() => ...)`. A run callback does not capture outer variables; pass them through `args`.
- Native OMP Puppeteer support is runtime tooling, not authorization to install Puppeteer as a second project E2E framework. Reuse project Playwright when appropriate. A globally installed package is not automatically importable by name from project code; prefer its working CLI or the project's existing runner. If a standalone diagnostic must import an already resolved external module on Windows, use a valid file URL (for example via pathToFileURL), not a bare C:/ path, and retain that verified invocation.

## Open, input, viewport and retained screenshot

In native JavaScript Eval, substitute the assigned unique tab name, local preview URL, application-ready selector and existing D: evidence directory:

```javascript
const tab = await browser.open({
  name: 'task-specific-wide', url: previewUrl,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  wait_until: 'domcontentloaded'
});
await tab.waitForSelector(readySelector);
display(await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, url: location.href })));
```

`browser.open.wait_until` accepts load, domcontentloaded, networkidle0 or networkidle2, never plain networkidle. Prefer a ready selector to network-idle for polling/streaming applications. Use `tab.fill` for text inputs, `tab.select` for native select, and `tab.press` or raw page.keyboard for keyboard actions. Re-observe after navigation or React replacement; use stable accessible/CSS selectors. A setter or DOM event injection does not establish user-input acceptance.

Native tab.waitFor accepts a selector, not a JavaScript predicate. For a predicate use raw `page.waitForFunction` inside tab.run with a finite timeout, or the existing Playwright assertion. Do not replace a failed condition wait with a 150ms sleep as the final acceptance method. Resolve launchers from the current environment instead of copying a pnpm.cmd path from an old session; inspect package.json script argument forwarding before adding extra `--` separators. For a built Next.js preview, the project's resolved Node executable plus `node_modules/next/dist/bin/next start --hostname 127.0.0.1 -p <port>` avoids pnpm batch quoting when that CLI path actually exists.

For raw-page operations and a real PNG saved on disk (the lightweight tab.screenshot has no path option):

```javascript
display(await tab.run(async ({ page }, evidencePath, width, height) => {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (actual.width !== width || actual.height !== height) throw Error('Viewport mismatch');
  await page.screenshot({ path: evidencePath, type: 'png', fullPage: true });
  return { evidencePath, ...actual };
}, { args: [evidencePath, 1440, 900] }));
```

Capture relevant narrow and wide views serially if sharing a tab. Read the saved images for visual review; a file path alone is not a review. Supplied current images normally need no recapture. Use absolute paths in the assigned D: evidence directory outside source from the first capture; retain final images and the minimal check/output, cleaning only explicitly named temporary artifacts after checking the retained references.

For a drawer/menu/animated panel, visible does not mean settled. After the real action, use a finite condition wait for the intended open state, completed relevant transition and expected viewport bounds. For example, a full-width mobile drawer must reach its intended x/width within a small pixel tolerance and stay stable over successive observations; include an actual usable control. Wait for relevant fonts/images when they affect layout. Scope animation checks to the target so decorative infinite animations cannot block acceptance. A timeout is unresolved evidence: inspect computed transform, bounds and ancestors before blaming clipping or adding Teleport. Do not replace this with a fixed 300/400/500ms sleep or remove product motion to make the check pass. Inspect actual motion separately when it is part of the brief.

## Real drag acceptance and bounded failure handling

Local runtime finding (2026-09-13): native OMP observe/DOM/viewport/PNG operations succeeded on the existing Tideline production sample, but handle.click and raw page.click on its visible Visit link timed out. The already-installed Playwright CLI successfully clicked the same application link. Root cause inside the native bridge is not established; do not blame product source solely on that timeout. Evidence: D:/OMPData/registry/delivery-contract-20260913. Relay is known working for its observed connection/observation scope, but clearing this historical native-input workaround requires a separately bounded current-runtime retest of click, input, drag and viewport behavior. Until that retest clears it, prefer existing project Playwright or the installed playwright-cli for real input acceptance on this machine; native Eval remains useful for observation/screenshots. Do not remove the workaround blindly or add a browser stack solely for it. After one diagnosed native action timeout, switch to the verified driver instead of repeating native variants.

Bounded retest (2026-09-19, OMP 18.2.6): opening a task-owned local fixture through Relay timed out at 12 seconds; therefore click, input and drag were not executed. Evidence: `D:/OMPData/omp-convergence-20260919/browser-retest.json`. This is a bounded local-fixture result, not proof that Relay or product interaction is unsupported; the historical fallback remains until a successful bounded retest covers the intended actions.

Installed CLI recovery (no dependency installation, use a unique task session and an isolated evidence cwd): `playwright-cli -s=<task> open <preview-url>`, `snapshot`, then `click <fresh-ref>` / `fill <fresh-ref> <text>` / `drag <fresh-source-ref> <fresh-target-ref>`, inspect the new snapshot/state, and `close` only that session. Use the current snapshot's refs, never copy e8 from another run. CLI click/drag performs real browser input; DOM evaluate clicks do not. A driver switch still requires proving every requested postcondition (including reload for persistence); successful navigation on this sample is not evidence that Paper Sprint dragging works. If this CLI is absent, use the existing project's Playwright runner or report the actual limitation, not another guessed API or automatic framework installation.

Use the project's actual input mechanism: native HTML5 drag, pointer-based library, keyboard alternative and touch are distinct acceptance paths. Start with its established Playwright/browser test or the installed Playwright CLI on this machine; use native input only after a runtime retest clears the documented timeout. Assert the actual target state and persistence if required. A successful tool call without a state transition is not PASS.

## Small tool-contract checks

On Windows, put multi-statement PowerShell with variables, pipelines, nested quotes or Add-Type in a task-owned UTF-8 script and run `powershell.exe -NoProfile -File <absolute-path>`. Save with BOM when Windows PowerShell 5.1 must read non-ASCII literals. Do not pass that script through another shell's double-quoted `-Command`: the outer shell can expand `$variable`/`$_` before PowerShell receives them. Use literal paths, a task-specific variable name, and inspect exit status and the requested state. Native process APIs need `cmd.exe /c <resolved-path>.cmd` for batch launchers, or the actual Node entry; a successful process spawn alone is not application readiness.

Keep tool output scoped to the assertion: inspect one affected UI region or search a saved snapshot, retain full output in the assigned evidence directory, and return only relevant state/error lines. A page snapshot and all completed hub jobs need not be reprinted after every action. Reuse the current tool schema and a working command after compaction; fix an argument error once from that schema instead of guessing variants.

Use literal paths with native read's separate offset/limit fields where supported; a `file.ts:1-220` suffix may be treated as part of the filename. Check the actual tool schema instead of copying another harness's syntax. `omp_checkpoint` top-level status is active/complete; requirement coverage is pending/covered/missing, never passed/partial. After an argument error, correct it from the current schema before retrying. Retain each hub service's actual name/ID for subsequent logs/stop calls instead of reconstructing it from the project name. Discover an installed browser runner before attempting to import a package that is not a project dependency.

For native HTML5 only, Puppeteer's ElementHandle.dragAndDrop requires `await page.setDragInterception(true)` on that SAME page in the SAME tab.run; restore with `finally { await page.setDragInterception(false); }`. Enabling only CDP Input.setInterceptDrags does not set Puppeteer's internal flag. This prerequisite is not proof that dragAndDrop works for a particular app/runtime. After timeout, inspect the real state and tool cause before retrying with a supported driver; do not keep trying API variants or leave interception enabled. Use finite action/assertion timeouts. Pointer-based libraries may require real mouse down/move/up; keyboard/touch require their own checks.

`dispatchEvent(new DragEvent(...))`, element.click inside evaluate, direct localStorage writes and direct store updates may be useful diagnostic checks, but label them synthetic/handler-level. They cannot replace a failed or unexecuted real input path. Retain the original failure and report a product FAIL or environment BLOCKED/INCONCLUSIVE until adequate evidence exists. Use isolated fixture data/origins; never clear real user storage to make a test pass.

## Handoff

Author: scoped milestone checks and exact tested source. Sol: final acceptance and evidence reuse decision. GPT visual reviewer: supplied rendered views and visual brief, not another complete functional suite. Existing required independent gates still apply. A short record of check, actual result, source/commit, preview mode, viewport and evidence path is sufficient; don't build a reporting subsystem.

## Critical regression evidence

For a persistent browser regression, use `product-testing` after the foundation exists and include the early login/create/edit/reload path when it is relevant. Assign the source/test author before review and one runtime owner before launch. The runtime owner alone controls that run's preview and services; reviewers remain read-only and never clean another reviewer's evidence.

Create a new unique evidence directory below `D:/Labs/omp` for each run. Record quoted absolute paths for the final snapshot, screenshot, trace, and relevant log/state output. Before completion, verify with existing tools that every retained reference exists, is nonempty, and belongs to the verified current run. Reviewer artifacts within that run are valid and protected; do not include shared-cleanup artifacts. Record the result with the receipt. Keep reusable assertions with product source; keep runtime fixtures, credentials, databases, and logs in the run directory. Cover requested negative-path and focus behavior with real browser input, and keep the post-reload state when persistence is claimed.

When evidence confirms a defect, transfer the bounded repair receipt to `repair-worker` (`@repair=Terra:high`), the separate write identity. The original author stops writes for that scope, and `repair-worker` cannot serve as its independent reviewer.

Retain the concrete final behavior result or replayable assertion before deleting temporary snapshots. A screenshot of the initial board and a prose PASS do not preserve the evidence of a dragged card remaining in its new column after reload. Keep only the relevant final trace/state, not every exploratory screenshot. For storage changes also verify startup with invalid/future existing storage and write/remove failures; file-upload rejection alone does not cover initialization.
