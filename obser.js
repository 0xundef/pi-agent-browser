// obser.js
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

// 在 ESM 中，__dirname 需要手动定义
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startObservation() {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    const client = await context.newCDPSession(page);

    await client.send('Network.enable');
    await client.send('Debugger.enable');

    client.on('Network.requestWillBeSent', (params) => {
      const { request, initiator } = params;
      if (initiator.stack && initiator.stack.callFrames.length > 0) {
        const topFrame = initiator.stack.callFrames[0];
        console.log(JSON.stringify({
          url: request.url,
          file: topFrame.url,
          line: topFrame.lineNumber + 1,
          function: topFrame.functionName || 'anonymous'
        }));
      }
    });

    console.log("CDP 观测器已连接到 9222 端口...");
  } catch (e) {
    console.error("连接失败，请确保 Chrome 已带参数 --remote-debugging-port=9222 启动");
  }
}

startObservation();