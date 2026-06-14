import { chromium, type Browser } from 'playwright';
import {
  executeStepWithCheckpoint,
  type CheckpointResult,
  type TemplateStep,
} from './steps.js';

export interface RunOptions {
  stepTemplate: TemplateStep[];
  parameters?: Record<string, string | number | boolean>;
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
}

export interface RunResult {
  success: boolean;
  checkpoints: CheckpointResult[];
  failedAt?: number;
  domSnapshot?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runCapability(options: RunOptions): Promise<RunResult> {
  const checkpoints: CheckpointResult[] = [];
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      headless: options.headless ?? false,
      slowMo: options.slowMo ?? 50,
    });
    const page = await browser.newPage();
    const ctx = {
      page,
      parameters: options.parameters ?? {},
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    for (let i = 0; i < options.stepTemplate.length; i++) {
      const result = await executeStepWithCheckpoint(i, options.stepTemplate[i], ctx);
      checkpoints.push(result);
      if (result.status === 'failed') {
        const domSnapshot = await page.content().catch(() => undefined);
        return {
          success: false,
          checkpoints,
          failedAt: i,
          domSnapshot: domSnapshot?.slice(0, 50_000),
          error: result.message,
        };
      }
    }

    return { success: true, checkpoints };
  } catch (err) {
    return {
      success: false,
      checkpoints,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
