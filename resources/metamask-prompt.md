# MetaMask extension test prompt (recovered)

This text was **not** preserved as `prompt.md` in git. It comes from the inline `prompt` string in `index.ts` **before** commit `0dc0d68` (“feat(agent): add extension management…”), which moved instructions into `samples/<id>/prompt.md` instead.

Only minimal edits were applied for today’s tooling: `recordings.json` (the original said `recording.json`), and a note on the Playwright config filename.

## Constraints (CSP / `eval` — MetaMask and extension pages)

MetaMask’s UI runs on **`chrome-extension://…`** origins with a strict **Content Security Policy** that typically **blocks `eval` and inline script execution**.

- **Do not** use `playwright-cli eval …` (or similar “inject and run arbitrary JS string” automation) **while focused on the MetaMask / extension UI**—it often fails or appears blocked for this reason.
- **Prefer** flows that do not rely on `eval` for extension pages: tab selection, snapshots, clicking by stable labels / roles, keyboard input, and screenshots. Use `playwright-cli --help` and your `cli_config.json` for supported non-eval commands.
- On **normal `https://` test dapps**, `eval`-style checks may work if the page’s CSP allows it; still prefer the same non-eval style when possible for consistency.

---

Execute the following operations using the `shell_command` tool; **each page change should be screenshot** (use Playwright / `playwright-cli` as needed, consistent with **`cli_config.json`** in this extension directory).

1. Run: `playwright-cli open --config=./cli_config.json` (or an absolute path to that file).
2. Right after a successful open, call **`start_network_capture`** (clears the playwright-cli network log for this run).
3. Activate the MetaMask extension in the browser window.
4. Assume you are a MetaMask user and log in with your mnemonic phrase (you may use the `generate_mnemonic` tool if you need a fresh test phrase).
5. Exercise the wallet flow (unlock, network switch, connect to a test dApp if `cli_config.json` documents one, etc.). After each meaningful UI state, take a screenshot and append a step with **`record_step`** (`time` ISO 8601, `thinking`, `image` under `ai_testing/<runId>/`).
6. **Network traffic:** before finishing, call **`capture_network_traffic`**. It runs `playwright-cli network --request-headers --filter="https?://"` and writes **`ai_testing/<runId>/network.json`** (always call it—even with zero requests, the file must exist with `"requests": []`). All HTTPS matches are saved except `chrome-extension://` URLs.
7. Call **`validate_recordings`** to confirm **`recordings.json`** meets the schema, then summarize what was reachable.

## Finish order

Use **`capture_network_traffic`** → **`validate_recordings`** → short summary.

If any step fails, check the error message and try again. Use `playwright-cli --help` if needed.
