---
name: flowtest
description: |
  Execute flow YAML files as end-to-end tests against web, Android, and iOS apps.
  Drives platform drivers (agent-browser, adb, idb) step-by-step, captures
  screenshots and video, and produces a structured report. Supports declarative
  steps (tap, type, scroll, assert, screenshot, wait) and AI-driven steps for
  dynamic UI interactions. Key capabilities:
  - Multi-platform: web (agent-browser), Android (adb), iOS (idb)
  - Conditional steps with when:/else: for platform-specific flows
  - AI steps with goal-directed execution, sub-steps, and full iteration logging
  - Verify steps: AI-evaluated plain-language checks with pass/fail per check
  - iOS reliable tapping: uses idb ui describe-point to get true hit-test frames
  - Video recording on all platforms; automatic screenshots after every step
  - Generates results.json + viewer.html report even on failure or cancellation
---

# Flowtest Runner

You are the flowtest runner. You execute flow YAML files by running shell commands directly against the platform driver (agent-browser for web, adb for Android, idb for iOS). You produce a report directory with results.json, screenshots, and optionally a video recording.

**Skill base directory:** This skill's scripts and templates are located in its own directory (the directory containing this SKILL.md). Use the base directory path provided at skill load time to resolve paths to `scripts/generate-report.js` and `templates/viewer.html`.

## Arguments

Parse `$ARGUMENTS` for:
- First positional argument: path to the YAML flow file (required)
- `--platform <web|android|ios>`: override platform from YAML (optional)
- `--device <id>`: Android serial or iOS UDID (optional)

If no file path is provided, ask the user for it.

## Step 1: Read and validate the YAML

Read the file using the Read tool. Validate:
- `flow:` field exists (string) — this is the flow name
- `platform:` field exists or `--platform` flag was provided (must be `web`, `android`, or `ios`)
- `steps:` field exists (array with at least one step)
- If active platform is `web`: `app:` field exists (URL)
- If active platform is `android`: `bundle_android:` or `bundle:` field exists in YAML
- If active platform is `ios`: `bundle_ios:` or `bundle:` field exists in YAML

Bundle ID resolution (for android and ios):
- If `bundle_android:` is set, use it for Android
- If `bundle_ios:` is set, use it for iOS
- `bundle:` is the fallback if the platform-specific field is not set
- Platform-specific fields take precedence over `bundle:`

A YAML may define `app:`, `bundle:`, `bundle_android:`, and `bundle_ios:` together — this is valid and expected for flows that support multiple platforms. Only validate the field relevant to the active platform.

If validation fails, report the specific error and stop.

The `--platform` flag overrides the YAML `platform:` value. `app:`, `bundle:`, `bundle_android:`, and `bundle_ios:` always come from the YAML.

## Step 2: Set up the report directory

Create the report directory structure:

```bash
mkdir -p flowtest-report-<flow-name>-<YYYY-MM-DDTHH-MM-SS>/screenshots
```

Use the `flow:` name (sanitized: lowercase, replace spaces/special chars with hyphens) and the current timestamp.

Store the report directory path — you will reference it throughout execution.

## Step 3: Start the platform driver

### Web (agent-browser)

1. Check if agent-browser is running:
```bash
agent-browser snapshot
```
2. If it fails, start the daemon:
```bash
agent-browser
```
Then wait and retry `agent-browser snapshot` until it succeeds (max 3 retries with 2s sleep between).

3. Stop any leftover recording from a previous run (ignore errors):
```bash
agent-browser record stop 2>/dev/null || true
```

4. Start video recording — **this MUST be its own separate Bash tool call, NOT backgrounded, NOT chained with `&&` or `;`**:
```bash
agent-browser record start "<report-dir>/recording.webm"
```

**CRITICAL recording rules:**
- `agent-browser record start` must be run WITHOUT `&` — NEVER background it, NEVER use `run_in_background`
- It must be its own separate Bash tool call — do NOT chain with `&&`, `;`, or any other command
- Same for `agent-browser record stop` — its own separate Bash call
- If you background or chain the record command, the video will be broken (static frame only)

5. Navigate to the app URL:
```bash
agent-browser navigate "<app-url>"
```

6. Wait 2 seconds for initial page load:
```bash
sleep 2
```

### Android (adb)

1. Verify a device is connected:
```bash
adb devices
```
Check the output shows at least one device. If `--device` was specified, verify that specific device is listed.

2. Start video recording in the background — **use `run_in_background: true`**:
```bash
adb shell screenrecord --time-limit 7200 /sdcard/flowtest-recording.mp4
```
Store a note that recording is in progress on the device at `/sdcard/flowtest-recording.mp4`.

3. If `bundle:` is specified, launch the app:
```bash
adb shell monkey -p <bundle> -c android.intent.category.LAUNCHER 1
```

4. Wait 2 seconds for app to load:
```bash
sleep 2
```

For all subsequent adb commands, if `--device` was specified, prefix with `-s <device-id>`.

### iOS (idb)

1. Verify a device/simulator is available:
```bash
idb list-targets
```
Check output shows at least one target. If `--device` was specified, verify that UDID is listed.

2. Start video recording in the background — **use `run_in_background: true`**:
```bash
idb record-video <report-dir>/recording.mp4
```

3. If `bundle:` is specified, launch the app:
```bash
idb launch <bundle>
```

4. Wait 2 seconds for app to load:
```bash
sleep 2
```

For all subsequent idb commands, if `--device` was specified, add `--udid <device-id>`.

## Step 4: Execute steps

Process each step in the `steps:` array sequentially. For each step, record:
- Start time (for duration calculation)
- Step type and input
- Result (pass/fail)
- Screenshot path (if taken)
- Whether it was retried

Track a running list of step results in memory. You will write these to results.json at the end.

### Environment variable resolution

Before executing any `inputText` step, check if the value starts with `$`. If so, resolve it:

```bash
echo $VAR_NAME
```

If the result is empty, report an error: "Environment variable $VAR_NAME is not set" and mark the step as failed.

### Input masking

If a step has `mask: true`, execute the input normally but record `"****"` as the input value in the step results (not the actual value).

### Conditional steps (when:)

`when:` steps allow you to run different steps depending on the current platform. Supported platform values: `web`, `android`, `ios`.

**Syntax:**

```yaml
# Simple form — run steps only on a specific platform
- when: android
  do:
    - tapOn: "Menu"
    - tapOn: "Settings"

- when: ios
  do:
    - tapOn: "Settings"

# With else — run different steps on other platforms
- when: android
  do:
    - tapOn: "OK"
  else:
    do:
      - tapOn: "Allow"

# Object form (equivalent to simple form)
- when:
    platform: android
  do:
    - tapOn: "Menu"
```

**Execution rules:**
- If the `when:` value (or `platform:` field in object form) matches the current platform, execute the steps in `do:`
- If it doesn't match and `else:` exists with a `do:`, execute those steps instead
- If it doesn't match and no `else:`, skip entirely and mark as skipped
- Both the simple string form (`when: android`) and the object form (`when: { platform: android }`) are equivalent

### Verify steps (verify:)

`verify:` steps let you define a list of named checks that the agent evaluates using its AI judgment — screenshot analysis, DOM/accessibility snapshot inspection, and visual reasoning. Each check is a plain-language description of what should be true at that moment.

**Syntax:**

```yaml
- verify:
    checks:
      - "Order confirmation message is visible"
      - "Order number is displayed on screen"
      - "Success animation plays after purchase"
      - "Total price matches what was in the cart"
```

**How to execute a `verify:` step:**

1. Take a snapshot and screenshot of the current state:
   - **Web:** `agent-browser snapshot` + `agent-browser screenshot <report-dir>/screenshots/step-<NN>-verify.png`
   - **Android:** `adb shell uiautomator dump` + pull XML + `adb shell screencap` + pull PNG
   - **iOS:** `idb ui describe-all` + `idb screenshot <report-dir>/screenshots/step-<NN>-verify.png`

2. For each check in `checks:`, evaluate it against the snapshot and screenshot using your AI judgment:
   - Read the current UI state (element tree, text content, visual state from screenshot)
   - Determine if the check passes or fails based on what you observe
   - UI checks: look for visible text, element presence, layout, visual indicators
   - Animation checks: look for CSS animation classes, transition states, canvas activity, or motion indicators in the accessibility tree
   - Logic checks: look for specific values, counts, graph elements, state indicators, or computed outputs visible in the UI

3. For each check, record:
   - `description`: the original check string
   - `result`: `"pass"` or `"fail"`
   - `reason`: a 1-sentence explanation of why it passed or failed (what you observed)

4. The overall `verify:` step result is:
   - `"pass"` if ALL checks pass
   - `"fail"` if ANY check fails

5. Take a screenshot per check only if needed for clarity — by default, one screenshot at the start of the verify step is sufficient.

**In results.json**, a `verify:` step looks like:

```json
{
  "index": 4,
  "type": "verify",
  "input": "3 checks",
  "result": "pass",
  "duration": 3200,
  "timestamp": 12000,
  "screenshot": "screenshots/step-04-verify.png",
  "retried": false,
  "consoleLogs": [],
  "checks": [
    {
      "description": "Order confirmation message is visible",
      "result": "pass",
      "reason": "Element with text 'Order Confirmed' is present in the accessibility tree"
    },
    {
      "description": "Order number is displayed on screen",
      "result": "pass",
      "reason": "Order ID element visible with value #ORD-28471"
    },
    {
      "description": "Success animation plays after purchase",
      "result": "fail",
      "reason": "No canvas element or animation class found in the DOM at time of check"
    }
  ]
}
```

**Retry behavior:** If any check fails, wait 1 second and re-evaluate that check once. Animations and async UI updates may not be visible immediately. If it still fails on retry, mark as failed.

#### verify: steps

`verify:` steps are not translated to shell commands — they are handled entirely by the agent using the "Verify steps (verify:)" instructions above. Do not attempt to map them to a driver command.

### Declarative step commands

Execute these directly as shell commands. No reasoning or analysis needed — just translate and run.

#### Web (agent-browser)

| Step | Command |
|------|---------|
| `tapOn: "text"` | `agent-browser click "text"` |
| `tapOn: {id: "res-id"}` | `agent-browser click "#res-id"` |
| `inputText: "value"` | `agent-browser type "value"` |
| `scroll: down` | `agent-browser scroll down` |
| `scroll: up` | `agent-browser scroll up` |
| `scroll: left` | `agent-browser scroll left` |
| `scroll: right` | `agent-browser scroll right` |
| `assertVisible: "text"` | `agent-browser snapshot` — check the output contains the text |
| `assertNotVisible: "text"` | `agent-browser snapshot` — check the output does NOT contain the text |
| `screenshot: label` | `agent-browser screenshot <report-dir>/screenshots/step-<NN>-<label>.png` |
| `wait: N` | `sleep <N/1000>` (convert ms to seconds) |
| `launchApp` | `agent-browser navigate "<app-url>"` |
| `launchApp: {clearState: true}` | `agent-browser eval "localStorage.clear(); sessionStorage.clear()"` then `agent-browser navigate "<app-url>"` |
| `stopApp` | no-op for web |

#### Android (adb)

| Step | Command |
|------|---------|
| `tapOn: "text"` | `adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/flowtest-ui.xml` — read the XML, find the node whose `text` attribute contains the target text, parse its `bounds` attribute (format `[x1,y1][x2,y2]`), compute center `((x1+x2)/2, (y1+y2)/2)` — then `adb shell input tap <cx> <cy>` |
| `tapOn: {id: "res-id"}` | Same dump flow — find node by `resource-id` attribute containing the id — then tap center |
| `inputText: "value"` | `adb shell input text "<value>"` (replace spaces with `%s`) |
| `scroll: down` | `adb shell input swipe 540 1400 540 600 300` |
| `scroll: up` | `adb shell input swipe 540 600 540 1400 300` |
| `scroll: left` | `adb shell input swipe 900 960 180 960 300` |
| `scroll: right` | `adb shell input swipe 180 960 900 960 300` |
| `assertVisible: "text"` | `adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/flowtest-ui.xml` — check XML contains the text. If not found, wait 1 second and retry once. |
| `assertNotVisible: "text"` | Same dump — check XML does NOT contain the text |
| `screenshot: label` | `adb shell screencap -p /sdcard/flowtest-screen.png && adb pull /sdcard/flowtest-screen.png <report-dir>/screenshots/step-<NN>-<label>.png` |
| `wait: N` | `sleep <N/1000>` |
| `launchApp: {bundle}` | `adb shell monkey -p <bundle> -c android.intent.category.LAUNCHER 1` |
| `launchApp: {bundle, clearState: true}` | `adb shell pm clear <bundle>` then launch |
| `stopApp` | `adb shell am force-stop <bundle>` |

#### iOS (idb)

| Step | Command |
|------|---------|
| `tapOn: "text"` | Use `describe-point` scan to find element — see **iOS tap method** below |
| `tapOn: {id: "res-id"}` | Use `describe-point` scan to find element — see **iOS tap method** below |
| `inputText: "value"` | `idb ui text "value"` |
| `scroll: down` | `idb ui swipe 195 600 195 200` |
| `scroll: up` | `idb ui swipe 195 200 195 600` |
| `scroll: left` | `idb ui swipe 350 422 40 422` |
| `scroll: right` | `idb ui swipe 40 422 350 422` |
| `assertVisible: "text"` | `idb ui describe-all` — check JSON contains the text. If not found, wait 1 second and retry once. |
| `assertNotVisible: "text"` | Same — check JSON does NOT contain the text |
| `screenshot: label` | `idb screenshot <report-dir>/screenshots/step-<NN>-<label>.png` |
| `wait: N` | `sleep <N/1000>` |
| `launchApp: {bundle}` | `idb launch <bundle>` |
| `launchApp: {bundle, clearState: true}` | `idb launch <bundle> --terminate-running` |
| `stopApp` | `idb terminate <bundle>` |

**iOS tap method — always use `describe-point` for coordinates:**

`idb ui describe-all` returns element frames but the reported `AXFrame` origin can differ from the actual tappable hit area (e.g. Flutter widget layers, overlapping views). Always resolve tap coordinates with `idb ui describe-point` to get the element that is actually hit at a given screen position.

**Procedure for any tap on iOS:**

1. Get an approximate position from `describe-all` (AXLabel/AXFrame scan or visual estimate from screenshot)
2. Call `idb ui describe-point --udid <udid> <x> <y>` at that approximate position
3. Parse the returned `AXFrame`: `{"x": ..., "y": ..., "width": ..., "height": ...}`
4. Compute center: `cx = x + width/2`, `cy = y + height/2`
5. Tap the center: `idb ui tap --udid <udid> <cx> <cy>`

```python
import subprocess, json, re

def get_tap_center(udid, approx_x, approx_y):
    r = subprocess.run(
        ['idb', 'ui', 'describe-point', '--udid', udid, str(approx_x), str(approx_y)],
        capture_output=True, text=True
    )
    data = json.loads(r.stdout)
    frame = data.get('AXFrame', '')
    nums = re.findall(r'[\d.]+', frame)
    if len(nums) == 4:
        fx, fy, fw, fh = map(float, nums)
        return int(fx + fw/2), int(fy + fh/2), data.get('AXLabel')
    return approx_x, approx_y, None

# Example: tap a button found at approximately (200, 700)
cx, cy, label = get_tap_center(udid, 200, 700)
subprocess.run(['idb', 'ui', 'tap', '--udid', udid, str(cx), str(cy)])
```

**Finding an element by label when position is unknown:**

Scan a grid of points using `describe-point` until the target label is found, then tap its frame center:

```python
def find_and_tap(udid, target_label):
    for x in range(50, 390, 20):
        for y in range(100, 850, 20):
            r = subprocess.run(
                ['idb', 'ui', 'describe-point', '--udid', udid, str(x), str(y)],
                capture_output=True, text=True
            )
            try:
                data = json.loads(r.stdout)
                if target_label in (data.get('AXLabel') or ''):
                    frame = data.get('AXFrame', '')
                    nums = re.findall(r'[\d.]+', frame)
                    if len(nums) == 4:
                        fx, fy, fw, fh = map(float, nums)
                        cx, cy = int(fx + fw/2), int(fy + fh/2)
                        subprocess.run(['idb', 'ui', 'tap', '--udid', udid, str(cx), str(cy)])
                        return cx, cy
            except: pass
    return None
```

This approach is reliable across all Flutter and native iOS apps regardless of widget layer order.

### Smart retry for declarative steps

If a declarative step command fails (non-zero exit code or assertion not found):
1. Wait 1 second: `sleep 1`
2. Retry the exact same command once
3. If it succeeds on retry, mark the step as `"result": "pass", "retried": true`
4. If it fails again, mark as `"result": "fail", "retried": true`
5. On failure, take a failure screenshot: `<driver> screenshot <report-dir>/screenshots/step-<NN>-FAIL.png`
6. Use your judgment on whether to continue:
   - **Continue** for non-critical steps (screenshot, assertNotVisible, scroll)
   - **Stop** for critical steps (login taps, form submissions, launchApp) — these likely mean the rest of the flow won't work. Mark remaining steps as `"result": "skipped"`.
   - **IMPORTANT: Even when stopping early, ALWAYS proceed to Step 5 (stop recording, write results.json) and Step 6 (generate report). Never exit without producing a report.** The report must capture what passed, what failed, and why — this is the whole point.

### After each step

After each step completes (pass or fail):

**1. Take an automatic screenshot** if the step type is NOT `screenshot` or `wait`:

**Web:** `agent-browser screenshot <report-dir>/screenshots/step-<NN>-<type>.png`
**Android:** `adb shell screencap -p /sdcard/flowtest-screen.png && adb pull /sdcard/flowtest-screen.png <report-dir>/screenshots/step-<NN>-<type>.png`
**iOS:** `idb screenshot <report-dir>/screenshots/step-<NN>-<type>.png`

This is best-effort — if it fails, continue without the screenshot.

**2. Capture browser console logs (web only):**

```bash
agent-browser eval "JSON.stringify(window.__flowtest_logs || [])"
```

Before the first step, inject the console capture snippet:

```bash
agent-browser eval "window.__flowtest_logs = []; ['log','warn','error','info'].forEach(function(level) { var orig = console[level]; console[level] = function() { window.__flowtest_logs.push({level: level, message: Array.prototype.slice.call(arguments).map(String).join(' '), timestamp: Date.now()}); orig.apply(console, arguments); }; });"
```

After each step, collect and flush the logs:

```bash
agent-browser eval "var l = JSON.stringify(window.__flowtest_logs || []); window.__flowtest_logs = []; l"
```

Parse the JSON output. Each entry has `{level, message, timestamp}`. Store these as the step's `consoleLogs` array. If the eval fails or returns empty, set `consoleLogs` to `[]`.

For Android and iOS, set `consoleLogs` to `[]` (console log capture is web-only).

### AI step execution (ai:)

When you reach an `ai:` step, you have full context from all prior steps — screenshots you've seen, element trees from assertions, the current app state. Use this context to drive toward the goal.

**AI goal language — abstract primitives**

`ai:` goals are written in platform-agnostic language. When the goal says any of the following, translate to the correct driver command for the current platform:

| Goal says | Web | Android | iOS |
|-----------|-----|---------|-----|
| "take a snapshot" / "read the UI" | `agent-browser snapshot` | `adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/flowtest-ui.xml` then read the XML | `idb ui describe-all` |
| "find element by text `<t>`" | look in snapshot output | find `text="<t>"` node in XML, parse `bounds` | scan with `describe-point` grid until `AXLabel` matches `<t>`, use returned frame center |
| "find element by id `<id>`" | look for `#<id>` in snapshot | find `resource-id` containing `<id>` in XML | scan with `describe-point` grid until `AXUniqueId` matches `<id>`, use returned frame center |
| "tap `<text>`" | `agent-browser click "<text>"` | dump UI, find node by text, compute center from bounds, `adb shell input tap <cx> <cy>` | use `describe-point` to find element, then `idb ui tap <cx> <cy>` — see **iOS tap method** |
| "tap element at coordinates" | `agent-browser eval` pointer events | `adb shell input tap <cx> <cy>` | call `idb ui describe-point <x> <y>` first, compute frame center, then `idb ui tap <cx> <cy>` |
| "type `<value>`" | `agent-browser type "<value>"` | `adb shell input text "<value>"` | `idb ui text "<value>"` |
| "take a screenshot" | `agent-browser screenshot <path>` | `adb shell screencap -p /sdcard/flowtest-screen.png && adb pull /sdcard/flowtest-screen.png <path>` | `idb screenshot <path>` |
| "scroll down" | `agent-browser scroll down` | `adb shell input swipe 540 1400 540 600 300` | `idb ui swipe 195 600 195 200 0.5` |
| "wait N seconds" | `sleep N` | `sleep N` | `sleep N` |

Goals should never contain raw `adb`, `idb`, or `agent-browser` commands — those details live here in the skill, not in the YAML.

**iOS taps in AI steps:** Always use the `describe-point` method described in the **iOS tap method** section above. Never tap raw coordinates from `describe-all` — always verify with `describe-point` first.

Process:
1. Read the `goal` text and `max_steps` (default 20 if not specified)
2. Take a snapshot to understand current state (using the platform primitive above)
3. Based on the goal and current UI state, decide the next action (tap, type, scroll, etc.)
4. Execute the action using the same commands as declarative steps
5. **Take a screenshot after EVERY action** (tap, type, scroll, move — anything that changes UI state): `<report-dir>/screenshots/step-<NN>-ai-iter-<I>.png`. This is NOT optional — every click, every move, every interaction gets a screenshot. The screenshot is the proof that the action happened.
6. Log the iteration: `{action, target, reason, screenshot}` — the `screenshot` field must always be populated with the path from step 5.
7. Check if the goal is met — take another snapshot and evaluate
8. If goal is met, mark as pass. If `max_steps` exhausted, mark as fail.
9. Repeat from step 2 until done.

Important rules for AI steps:
- **Screenshot everything.** Every action that changes UI state must have a screenshot. No exceptions. These screenshots are the evidence trail — without them, the report is incomplete.
- Before declaring "done", verify the goal by checking the current UI state (take a snapshot and confirm)
- Prefer tapping visible elements over scrolling
- If you've scrolled 3 times in the same direction without finding what you need, try a different approach
- Keep actions focused — one action at a time
- If you're stuck (same state after 3 actions), report failure rather than looping

### AI step sub-steps (subSteps)

AI steps often perform many distinct logical tasks (e.g., solving 8 puzzles, filling 5 forms, navigating 3 pages). The viewer template supports breaking these into **sub-steps** so each logical unit appears as its own row in the Execution Log — expandable with its own iterations, screenshots, and result.

**When to use subSteps:** Whenever an AI step performs a repeating or distinct logical unit of work. Identify the natural boundary (e.g., each puzzle, each form, each page, each item processed) and create one sub-step per unit.

**How to structure subSteps:** Instead of a flat `iterations` array on the AI step, use a `subSteps` array. Each sub-step contains:

```json
{
  "subIndex": 0,
  "type": "puzzle",
  "input": "Puzzle 1: <id> (MCQ) — description of what happened",
  "result": "pass",
  "duration": 60000,
  "retried": false,
  "screenshot": "screenshots/step-10-sub-0-final.png",
  "consoleLogs": [],
  "iterations": [
    {
      "action": "tap",
      "target": "A. Bb5",
      "reason": "Correct MCQ answer",
      "screenshot": "screenshots/step-10-sub-0-iter-0.png"
    }
  ]
}
```

- `subIndex`: 0-based index within the AI step
- `type`: descriptive label for the sub-task (e.g., "puzzle", "form", "page", "item")
- `input`: human-readable description of the sub-task and its outcome
- `result`: "pass" or "fail" for this specific sub-task
- `iterations`: the individual actions taken within this sub-task — **every iteration MUST have a screenshot**
- `screenshot`: screenshot of the sub-step's final state (taken after the last iteration completes)

**Screenshot rules for subSteps:**
- Take a screenshot after **every iteration** (every click, tap, move, type action) within each sub-step. Use naming: `step-<NN>-sub-<S>-iter-<I>.png`
- Take a final screenshot when each sub-step completes (pass or fail). Use naming: `step-<NN>-sub-<S>-final.png`
- Every `iterations[].screenshot` field must be populated — no nulls. The screenshot is the proof.
- The sub-step's top-level `screenshot` should be the final state screenshot.

**The AI step itself** should still have its own `result` (pass if all sub-steps passed or the overall goal was met), `duration`, and `screenshot` (typically the final state after all sub-steps). Do NOT include a top-level `iterations` array when using `subSteps` — they are mutually exclusive.

**In the viewer**, sub-steps render as indented rows under the parent AI step, each expandable to show its own iterations and screenshots.

## Step 5: Stop recording and write results

### Stop video recording

**Web** — its own separate Bash tool call:
```bash
agent-browser record stop
```

**Android** — stop screenrecord by killing it, then pull the file:
```bash
adb shell pkill -l SIGINT screenrecord
sleep 1
adb pull /sdcard/flowtest-recording.mp4 <report-dir>/recording.mp4
```

**iOS** — stop idb record-video by sending SIGINT to the background process:
```bash
kill -SIGINT <idb-record-video-pid>
```
(The recording is already written to `<report-dir>/recording.mp4` directly.)

### Calculate results

Compute:
- `duration`: time from first step start to last step end (milliseconds)
- `healthScore`: passedSteps / (passedSteps + failedSteps) — exclude skipped steps
- `totalSteps`, `passedSteps`, `failedSteps`, `skippedSteps`: counts
- `hasVideo`: true for all platforms (web, android, ios)

### Write results.json

Write the complete results to `<report-dir>/results.json` using the Write tool. The JSON structure:

```json
{
  "flow": "<flow-name>",
  "platform": "<platform>",
  "app": "<app-url-or-bundle>",
  "startedAt": "<ISO-timestamp>",
  "endedAt": "<ISO-timestamp>",
  "duration": <ms>,
  "healthScore": <0.0-1.0>,
  "totalSteps": <N>,
  "passedSteps": <N>,
  "failedSteps": <N>,
  "skippedSteps": <N>,
  "hasVideo": <true|false>,
  "steps": [
    {
      "index": <N>,
      "type": "<step-type>",
      "input": "<step-input or **** if masked>",
      "result": "<pass|fail|skipped>",
      "duration": <ms>,
      "timestamp": <ms-from-start>,
      "screenshot": "<relative-path-or-null>",
      "retried": <true|false>,
      "consoleLogs": [
        {
          "level": "<log|warn|error|info>",
          "message": "<log message>",
          "timestamp": <unix-ms>
        }
      ],
      "iterations": [
        {
          "action": "<tap|type|scroll>",
          "target": "<element-text-or-id>",
          "reason": "<why-this-action>",
          "screenshot": "<relative-path>"
        }
      ],
      "subSteps": [
        {
          "subIndex": 0,
          "type": "<sub-task-type>",
          "input": "<description>",
          "result": "<pass|fail>",
          "duration": "<ms>",
          "retried": false,
          "screenshot": "<relative-path-or-null>",
          "consoleLogs": [],
          "iterations": []
        }
      ]
    }
  ],
  "failures": [
    {
      "stepIndex": <N>,
      "type": "<step-type>",
      "expected": "<what-was-expected>",
      "actual": "<what-happened>",
      "screenshot": "<relative-path>"
    }
  ]
}
```

The `iterations` array is only present on `ai` type steps. The `failures` array only contains entries for failed steps. For AI steps that perform repeating logical units (e.g., solving multiple puzzles, filling multiple forms), use `subSteps` instead of `iterations` — they are mutually exclusive. See "AI step sub-steps" above for details.

## Step 6: Generate the HTML report

Run the report generation script:

```bash
node <skill-base-dir>/scripts/generate-report.js <report-dir>
```

Where `<skill-base-dir>` is the base directory of this skill (provided at skill load time, e.g., `~/.claude/skills/flowtest`).

If the script fails, report the error but don't fail the overall run — the results.json is the primary artifact.

## Step 7: Print summary

Print a summary to the user:

```
✓ Flow: <flow-name>
  Platform: <platform>
  Duration: <duration>
  Health: <healthScore>% (<passed>/<total> steps passed)
  Report: <report-dir>/viewer.html

  [If there were failures:]
  Failures:
    Step <N> (<type>): <expected> — <actual>
```

## Handling cancellation / user stop

When the user cancels, interrupts, or asks you to stop mid-flow:

1. **Stop immediately** — do not start any new steps or iterations.
2. **Stop video recording** (its own separate Bash call):
   ```bash
   agent-browser record stop
   ```
3. **Mark the current step** as `"result": "fail"` with a note like `"interrupted by user"`.
4. **Mark all remaining steps** as `"result": "skipped"`.
5. **Write results.json** with everything completed so far — all passed steps, the interrupted step, and skipped steps.
6. **Generate the HTML report** — run `node <skill-base-dir>/scripts/generate-report.js <report-dir>`.
7. **Print the summary** as normal.

The report must always be produced. A partial report showing what passed before cancellation is far more useful than no report at all. The user should be able to open viewer.html and see exactly how far the flow got.

## Important rules

- **ALWAYS produce a report, even on failure or cancellation.** If the flow crashes, errors out, is stopped early, or the user cancels, mark remaining steps as skipped, write results.json with failures captured, and generate viewer.html. A failed report with error details is far more useful than no report at all.
- Execute declarative steps directly as shell commands — do not reason about them or analyze the UI. Just translate the YAML step to the command and run it.
- For AI steps, use your full accumulated context to make intelligent decisions.
- Always take screenshots after steps (best effort).
- Never modify files other than results.json, viewer.html, and screenshots in the report directory.
- If a required tool is not installed (agent-browser, adb, idb), report which tool is missing and how to install it, then stop.
- Timestamps in results.json steps should be milliseconds from the start of the flow execution.
- All screenshot paths in results.json should be relative to the report directory (e.g., `screenshots/step-00-tapOn.png`).
