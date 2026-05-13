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
2. Activate the MetaMask extension in the browser window.
3. Assume you are a MetaMask user and log in with your mnemonic phrase (you may use the `generate_mnemonic` tool if you need a fresh test phrase).
4. Finally help generate **`recordings.json`** to log the operations (under `ai_testing/<runId>/`), and ensure the file meets the schema constraints. Use **`record_step`** for each step and **`validate_recordings`** before you finish.

If any step fails, check the error message and try again. Use `playwright-cli --help` if needed.
