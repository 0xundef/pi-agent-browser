import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, "dummy-extension");
const userDataDir = path.join(__dirname, ".tmp-user-data");

async function main() {
  console.log("Launching browser with extension from:", extensionPath);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode (or the new headless mode)
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const page = await context.newPage();
  await page.goto("https://example.com");
  console.log("Browser launched successfully without crashing!");
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  await context.close();
}

main().catch(console.error);